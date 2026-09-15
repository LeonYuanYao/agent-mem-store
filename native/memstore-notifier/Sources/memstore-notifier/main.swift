import AppKit
import Foundation
import MemStoreNotifierCore
@preconcurrency import UserNotifications

func writeResponse<T: Encodable>(_ response: T) {
    if let data = try? JSONEncoder().encode(response) { FileHandle.standardOutput.write(data) }
}

func notificationErrorCode(prefix: String, error: Error) -> String {
    let value = error as NSError
    let domain = value.domain.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "_" }
    return "\(prefix)_\(String(domain).prefix(48))_\(value.code)"
}

func authorizationStatusName(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: "not_determined"
    case .denied: "denied"
    case .authorized: "authorized"
    case .provisional: "provisional"
    case .ephemeral: "ephemeral"
    @unknown default: "unknown_\(status.rawValue)"
    }
}

func notificationSettingName(_ setting: UNNotificationSetting) -> String {
    switch setting {
    case .notSupported: "not_supported"
    case .disabled: "disabled"
    case .enabled: "enabled"
    @unknown default: "unknown_\(setting.rawValue)"
    }
}

@MainActor
func runNotifierCommand() async {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let command = arguments.first
    let center = UNUserNotificationCenter.current()
    // LaunchServices starts the app without a CLI command after a notification click.
    if command == nil || command?.hasPrefix("-psn_") == true {
        try? await Task.sleep(for: .seconds(15))
        appDelegate.startupFinished = true
        appDelegate.finishIfReady()
        return
    }
    if command == "action" {
        func option(_ name: String) -> String? {
            guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }
        do {
            guard arguments.count >= 3 else { throw ActionError.invalidAction }
            let selection = try NotificationSelection(action: arguments[1], reminderId: arguments[2],
                openUri: option("--uri"), days: Int(option("--days") ?? "7") ?? 0)
            let runtime = option("--runtime").map { URL(fileURLWithPath: $0) } ?? installedRuntime()
            let result = await handleSelection(selection, runtime: runtime)
            writeResponse(result)
            exit(result.state == "completed" ? 0 : 1)
        } catch {
            writeResponse(DeliveryResponse.failed(code: "invalid_action"))
            exit(2)
        }
    }
    do {
        if command == "status" {
            let settings = await center.notificationSettings()
            writeResponse(NotificationStatusResponse(
                authorizationStatus: authorizationStatusName(settings.authorizationStatus),
                alertSetting: notificationSettingName(settings.alertSetting),
                soundSetting: notificationSettingName(settings.soundSetting)))
            exit(0)
        }
        guard command == "authorize" || command == "deliver" else {
            writeResponse(DeliveryResponse.failed(code: "unsupported_command"))
            exit(2)
        }
        let granted = try await center.requestAuthorization(options: [.alert, .sound])
        guard granted else { writeResponse(DeliveryResponse.permissionDenied()); exit(1) }
        if command == "authorize" {
            writeResponse(DeliveryResponse.delivered(receipt: "authorization:granted"))
            exit(0)
        }
        let decoded = try JSONDecoder().decode(DeliveryRequest.self, from: FileHandle.standardInput.readDataToEndOfFile())
        let request = try DeliveryRequest(reminderId: decoded.reminderId, title: decoded.title, body: decoded.body,
                                          openUri: decoded.openUri, snoozeDays: decoded.snoozeDays)
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "memstore_review", actions: [
                UNNotificationAction(identifier: "open_inbox", title: "Open Review Inbox", options: [.foreground]),
                UNNotificationAction(identifier: "snooze", title: "Snooze \(request.snoozeDays) days")
            ], intentIdentifiers: [])
        ])
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        content.categoryIdentifier = "memstore_review"
        content.userInfo = ["reminder_id": request.reminderId, "open_uri": request.openUri, "snooze_days": request.snoozeDays]
        try await center.add(UNNotificationRequest(identifier: request.reminderId, content: content, trigger: nil))
        writeResponse(DeliveryResponse.delivered(receipt: "unrequest:\(request.reminderId)"))
        appDelegate.startupFinished = true
        appDelegate.finishIfReady()
    } catch {
        writeResponse(DeliveryResponse.failed(code: notificationErrorCode(prefix: "notification_failed", error: error)))
        exit(1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let appDelegate = NotificationAppDelegate()
app.delegate = appDelegate
// Register before AppKit finishes launching, including cold response launches.
UNUserNotificationCenter.current().delegate = appDelegate
app.run()
