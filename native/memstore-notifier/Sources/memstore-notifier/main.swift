import Foundation
import MemStoreNotifierCore
@preconcurrency import UserNotifications

final class ResponseBox: @unchecked Sendable {
    private let lock = NSLock()
    private var response = DeliveryResponse.failed(code: "notification_unknown_failure")

    func set(_ value: DeliveryResponse) {
        lock.lock()
        response = value
        lock.unlock()
    }

    func get() -> DeliveryResponse {
        lock.lock()
        defer { lock.unlock() }
        return response
    }
}

final class StatusBox: @unchecked Sendable {
    private let lock = NSLock()
    private var response: NotificationStatusResponse?

    func set(_ value: NotificationStatusResponse) {
        lock.lock()
        response = value
        lock.unlock()
    }

    func get() -> NotificationStatusResponse? {
        lock.lock()
        defer { lock.unlock() }
        return response
    }
}

func writeResponse<T: Encodable>(_ response: T) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(response) else {
        FileHandle.standardOutput.write(Data("{\"state\":\"failed\",\"errorCode\":\"encoding_failed\"}".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
}

func authorizationStatusName(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .notDetermined:
        "not_determined"
    case .denied:
        "denied"
    case .authorized:
        "authorized"
    case .provisional:
        "provisional"
    case .ephemeral:
        "ephemeral"
    @unknown default:
        "unknown_\(status.rawValue)"
    }
}

func notificationSettingName(_ setting: UNNotificationSetting) -> String {
    switch setting {
    case .notSupported:
        "not_supported"
    case .disabled:
        "disabled"
    case .enabled:
        "enabled"
    @unknown default:
        "unknown_\(setting.rawValue)"
    }
}

func notificationErrorCode(prefix: String, error: Error) -> String {
    let value = error as NSError
    let domain = value.domain.lowercased().map { character in
        character.isLetter || character.isNumber ? character : "_"
    }
    return "\(prefix)_\(String(domain).prefix(48))_\(value.code)"
}

let command = CommandLine.arguments.dropFirst().first
guard command == "deliver" || command == "authorize" || command == "status" else {
    writeResponse(DeliveryResponse.failed(code: "unsupported_command"))
    exit(2)
}

do {
    let center = UNUserNotificationCenter.current()
    if command == "status" {
        let semaphore = DispatchSemaphore(value: 0)
        let responseBox = StatusBox()
        center.getNotificationSettings { settings in
            responseBox.set(NotificationStatusResponse(
                authorizationStatus: authorizationStatusName(settings.authorizationStatus),
                alertSetting: notificationSettingName(settings.alertSetting),
                soundSetting: notificationSettingName(settings.soundSetting)
            ))
            semaphore.signal()
        }
        semaphore.wait()
        guard let response = responseBox.get() else {
            writeResponse(DeliveryResponse.failed(code: "notification_status_unavailable"))
            exit(1)
        }
        writeResponse(response)
        exit(0)
    }
    if command == "authorize" {
        let semaphore = DispatchSemaphore(value: 0)
        let responseBox = ResponseBox()
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error {
                responseBox.set(.failed(code: notificationErrorCode(
                    prefix: "notification_authorization_failed",
                    error: error
                )))
            } else if granted {
                responseBox.set(.delivered(receipt: "authorization:granted"))
            } else {
                responseBox.set(.permissionDenied())
            }
            semaphore.signal()
        }
        semaphore.wait()
        let response = responseBox.get()
        writeResponse(response)
        exit(response.state == "delivered" ? 0 : 1)
    }

    let data = FileHandle.standardInput.readDataToEndOfFile()
    let decoded = try JSONDecoder().decode(DeliveryRequest.self, from: data)
    let request = try DeliveryRequest(
        reminderId: decoded.reminderId,
        title: decoded.title,
        body: decoded.body,
        openUri: decoded.openUri,
        snoozeDays: decoded.snoozeDays
    )
    let open = UNNotificationAction(identifier: "open_inbox", title: "Open Review Inbox")
    let snooze = UNNotificationAction(identifier: "snooze", title: "Snooze 7 days")
    center.setNotificationCategories([
        UNNotificationCategory(
            identifier: "memstore_review",
            actions: [open, snooze],
            intentIdentifiers: []
        )
    ])
    let semaphore = DispatchSemaphore(value: 0)
    let responseBox = ResponseBox()
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        if let error {
            responseBox.set(.failed(code: notificationErrorCode(
                prefix: "notification_authorization_failed",
                error: error
            )))
            semaphore.signal()
            return
        }
        guard granted else {
            responseBox.set(.permissionDenied())
            semaphore.signal()
            return
        }
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        content.categoryIdentifier = "memstore_review"
        content.userInfo = [
            "reminder_id": request.reminderId,
            "open_uri": request.openUri,
            "snooze_days": request.snoozeDays
        ]
        let notification = UNNotificationRequest(
            identifier: request.reminderId,
            content: content,
            trigger: nil
        )
        center.add(notification) { error in
            responseBox.set(error.map {
                .failed(code: notificationErrorCode(
                    prefix: "notification_delivery_failed",
                    error: $0
                ))
            } ?? .delivered(receipt: "unrequest:\(request.reminderId)"))
            semaphore.signal()
        }
    }
    semaphore.wait()
    let response = responseBox.get()
    writeResponse(response)
    exit(response.state == "delivered" ? 0 : 1)
} catch {
    writeResponse(DeliveryResponse.failed(code: "invalid_request"))
    exit(2)
}
