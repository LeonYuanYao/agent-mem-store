import Foundation

public struct DeliveryRequest: Codable, Equatable, Sendable {
    public let reminderId: String
    public let title: String
    public let body: String
    public let openUri: String
    public let snoozeDays: Int

    public init(
        reminderId: String,
        title: String,
        body: String,
        openUri: String,
        snoozeDays: Int
    ) throws {
        guard reminderId.hasPrefix("msreminder_") else {
            throw ContractError.invalidReminderId
        }
        guard !title.isEmpty, title.count <= 80, !body.isEmpty, body.count <= 160 else {
            throw ContractError.invalidBoundedContent
        }
        guard let uri = URL(string: openUri), uri.scheme == "obsidian" else {
            throw ContractError.invalidOpenUri
        }
        guard (1...90).contains(snoozeDays) else {
            throw ContractError.invalidSnoozeDays
        }
        self.reminderId = reminderId
        self.title = title
        self.body = body
        self.openUri = openUri
        self.snoozeDays = snoozeDays
    }
}

public enum ContractError: Error, Equatable {
    case invalidReminderId
    case invalidBoundedContent
    case invalidOpenUri
    case invalidSnoozeDays
}

public struct DeliveryResponse: Codable, Equatable, Sendable {
    public let state: String
    public let receipt: String?
    public let errorCode: String?

    public static func delivered(receipt: String) -> Self {
        Self(state: "delivered", receipt: receipt, errorCode: nil)
    }

    public static func permissionDenied() -> Self {
        Self(state: "permission_denied", receipt: nil, errorCode: "notification_permission_denied")
    }

    public static func failed(code: String) -> Self {
        Self(state: "failed", receipt: nil, errorCode: code)
    }
}

public struct NotificationStatusResponse: Codable, Equatable, Sendable {
    public let state: String
    public let authorizationStatus: String
    public let alertSetting: String
    public let soundSetting: String

    public init(
        authorizationStatus: String,
        alertSetting: String,
        soundSetting: String
    ) {
        self.state = "status"
        self.authorizationStatus = authorizationStatus
        self.alertSetting = alertSetting
        self.soundSetting = soundSetting
    }
}

public enum NotificationAction: String, Codable, Sendable {
    case openInbox = "open_inbox"
    case snooze
}

public struct ActionCallback: Codable, Equatable, Sendable {
    public let reminderId: String
    public let action: NotificationAction
    public let occurredAt: String

    public init(reminderId: String, action: NotificationAction, occurredAt: String) throws {
        guard reminderId.hasPrefix("msreminder_") else {
            throw ContractError.invalidReminderId
        }
        guard ISO8601DateFormatter().date(from: occurredAt) != nil else {
            throw ContractError.invalidBoundedContent
        }
        self.reminderId = reminderId
        self.action = action
        self.occurredAt = occurredAt
    }
}
