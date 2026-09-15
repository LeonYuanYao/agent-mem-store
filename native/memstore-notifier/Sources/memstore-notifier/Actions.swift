import AppKit
import Foundation
import OSLog
@preconcurrency import UserNotifications

struct ActionResult: Encodable {
    let state: String
    let action: String
    let reminderId: String
    let occurredAt: String
    let errorCode: String?
}

struct NotificationSelection {
    let action: String
    let reminderId: String
    let uri: URL?
    let days: Int

    init(action: String, reminderId: String, openUri: String?, days: Int) throws {
        let normalized = action == UNNotificationDefaultActionIdentifier ? "open_inbox" : action
        guard ["open_inbox", "snooze"].contains(normalized),
              reminderId.range(of: "^msreminder_[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              (1...90).contains(days) else { throw ActionError.invalidAction }
        var uri: URL?
        if normalized == "open_inbox" {
            guard let openUri, let components = URLComponents(string: openUri),
                  components.scheme == "obsidian", components.host == "open",
                  components.user == nil, components.password == nil,
                  let query = components.queryItems, query.count == 2,
                  query.filter({ $0.name == "vault" && !($0.value ?? "").isEmpty }).count == 1,
                  query.filter({ $0.name == "file" && $0.value == "_MemStore/Review Inbox.md" }).count == 1,
                  let url = components.url else { throw ActionError.invalidAction }
            uri = url
        }
        self.action = normalized
        self.reminderId = reminderId
        self.uri = uri
        self.days = days
    }
}

enum ActionError: Error { case invalidAction, missingInstallation, untrustedLauncher }

// Only the owner-controlled installation manifest selects a command, never the notification.
struct ManagedLauncher: Decodable {
    struct Target: Decodable { let label: String; let path: String }
    let schemaVersion: Int
    let state: String
    let targets: [Target]

    static func load(runtime: URL) throws -> URL {
        let manifest = runtime.appendingPathComponent("install/ownership-manifest.json")
        try requireOwnerOnly(manifest)
        let value = try JSONDecoder().decode(Self.self, from: Data(contentsOf: manifest))
        guard value.schemaVersion == 1, value.state == "installed",
              let target = value.targets.first(where: { $0.label == "memstore_cli" }),
              target.path.hasPrefix("/") else { throw ActionError.missingInstallation }
        let launcher = URL(fileURLWithPath: target.path)
        try requireOwnerOnly(launcher)
        guard FileManager.default.isExecutableFile(atPath: launcher.path) else { throw ActionError.untrustedLauncher }
        return launcher
    }

    static func requireOwnerOnly(_ url: URL) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let owner = attributes[.ownerAccountID] as? NSNumber, owner.uint32Value == getuid(),
              let mode = attributes[.posixPermissions] as? NSNumber,
              mode.intValue & 0o022 == 0 else { throw ActionError.untrustedLauncher }
    }
}

func installedRuntime() -> URL? {
    let bundle = Bundle.main.bundleURL
    guard bundle.pathExtension == "app", bundle.deletingLastPathComponent().lastPathComponent == "bin" else { return nil }
    return bundle.deletingLastPathComponent().deletingLastPathComponent()
}

@MainActor
func runReviewCommand(launcher: URL, runtime: URL, selection: NotificationSelection) async -> Bool {
    let child = Process()
    child.executableURL = launcher
    var arguments = ["review", selection.action == "snooze" ? "snooze-reminder" : "acknowledge-reminder",
                     selection.reminderId, "--runtime", runtime.path, "--json"]
    if selection.action == "snooze" { arguments += ["--days", String(selection.days)] }
    child.arguments = arguments
    child.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory()]
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    do { try child.run() } catch { return false }
    let deadline = Date().addingTimeInterval(8)
    while child.isRunning && Date() < deadline { try? await Task.sleep(for: .milliseconds(50)) }
    if child.isRunning {
        child.terminate()
        try? await Task.sleep(for: .milliseconds(100))
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        return false
    }
    return child.terminationStatus == 0
}

@MainActor
func handleSelection(_ selection: NotificationSelection, runtime: URL?) async -> ActionResult {
    let occurredAt = ISO8601DateFormatter().string(from: Date())
    var errorCode: String?
    if let uri = selection.uri, !NSWorkspace.shared.open(uri) {
        errorCode = "obsidian_open_failed"
    } else if let runtime {
        do {
            let launcher = try ManagedLauncher.load(runtime: runtime)
            var completed = false
            for attempt in 0..<3 {
                if await runReviewCommand(launcher: launcher, runtime: runtime, selection: selection) {
                    completed = true
                    break
                }
                if attempt < 2 { try? await Task.sleep(for: .milliseconds(250)) }
            }
            if !completed { errorCode = "review_state_update_failed" }
        } catch { errorCode = "review_launcher_unavailable" }
    } else { errorCode = "notifier_not_installed" }
    let result = ActionResult(state: errorCode == nil ? "completed" : "failed", action: selection.action,
                              reminderId: selection.reminderId, occurredAt: occurredAt, errorCode: errorCode)
    // One bounded body-free diagnostic, not an ever-growing notification log.
    if let runtime {
        do {
            let file = runtime.appendingPathComponent("state/notifier-last-action.json")
            try JSONEncoder().encode(result).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch {
            Logger(subsystem: "com.leonyuanyaoyao.memstore.notifier", category: "action")
                .error("notification_action_receipt_write_failed")
        }
    }
    Logger(subsystem: "com.leonyuanyaoyao.memstore.notifier", category: "action")
        .notice("action=\(selection.action, privacy: .public) result=\(errorCode ?? "completed", privacy: .public)")
    return result
}

@MainActor
final class NotificationAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var activeActions = 0
    var startupFinished = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { await runNotifierCommand() }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let action = response.actionIdentifier
        let payload = response.notification.request.content.userInfo
        let reminderId = payload["reminder_id"] as? String ?? ""
        let uri = payload["open_uri"] as? String
        let days = payload["snooze_days"] as? Int ?? 7
        Task { @MainActor in
            activeActions += 1
            defer {
                completionHandler()
                activeActions -= 1
                finishIfReady()
            }
            guard action != UNNotificationDismissActionIdentifier else { return }
            do {
                let selection = try NotificationSelection(action: action, reminderId: reminderId, openUri: uri, days: days)
                let result = await handleSelection(selection, runtime: installedRuntime())
                if result.state == "failed" {
                    let alert = NSAlert()
                    alert.messageText = "MemStore notification action failed"
                    alert.informativeText = result.errorCode == "obsidian_open_failed"
                        ? "Could not open Obsidian. Open _MemStore/Review Inbox.md in your Vault manually."
                        : "Could not save the reminder action. Knowledge was not changed. See notifier-last-action.json in the runtime state directory."
                    alert.runModal()
                }
            } catch {
                Logger(subsystem: "com.leonyuanyaoyao.memstore.notifier", category: "action").error("invalid_notification_action")
            }
        }
    }

    func finishIfReady() {
        if startupFinished && activeActions == 0 { NSApplication.shared.terminate(nil) }
    }
}
