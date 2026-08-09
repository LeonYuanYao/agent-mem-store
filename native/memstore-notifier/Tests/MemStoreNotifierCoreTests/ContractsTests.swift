import Foundation
import Testing
@testable import MemStoreNotifierCore

@Test func deliveryContractAcceptsOnlyBoundedObsidianRequests() throws {
    let request = try DeliveryRequest(
        reminderId: "msreminder_123",
        title: "MemStore review available",
        body: "3 items are ready in Review Inbox.",
        openUri: "obsidian://open?vault=Memory&file=_MemStore%2FReview%20Inbox.md",
        snoozeDays: 7
    )
    #expect(request.snoozeDays == 7)
    #expect(throws: ContractError.invalidOpenUri) {
        try DeliveryRequest(
            reminderId: "msreminder_123",
            title: "Review",
            body: "One item.",
            openUri: "https://example.com",
            snoozeDays: 7
        )
    }
}

@Test func actionCallbackIsBodyFreeAndTyped() throws {
    let callback = try ActionCallback(
        reminderId: "msreminder_123",
        action: .snooze,
        occurredAt: "2026-08-08T03:00:00Z"
    )
    let encoded = try JSONEncoder().encode(callback)
    let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(object["action"] as? String == "snooze")
    #expect(object["body"] == nil)
}

@Test func notificationStatusIsBoundedAndTyped() throws {
    let response = NotificationStatusResponse(
        authorizationStatus: "denied",
        alertSetting: "disabled",
        soundSetting: "disabled"
    )
    let encoded = try JSONEncoder().encode(response)
    let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(object["state"] as? String == "status")
    #expect(object["authorizationStatus"] as? String == "denied")
    #expect(object["alertSetting"] as? String == "disabled")
    #expect(object["soundSetting"] as? String == "disabled")
}
