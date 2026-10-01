import XCTest
@testable import NovaConnectNative

final class WorkflowTests: XCTestCase {
    func testMessageRetainsApprovalMetadata() throws {
        let data = Data(#"{"id":8,"body":"Found server","author":{"id":2,"username":"bot","full_name":"NovaDesk"},"created_at":"2026-10-01 15:00:00","edited":false,"deleted":false,"reactions":[],"attachments":[],"metadata":{"cardType":"decom_approval","changeId":61,"changeNumber":"CHG000061","status":"approved","requestedBy":"Eva","plannedStart":"2026-10-01T18:00:00Z"}}"#.utf8)
        let message = try JSONDecoder().decode(Message.self, from: data)
        let metadata = try XCTUnwrap(message.metadata)
        XCTAssertEqual(metadata.text("changeId"), "61")
        XCTAssertEqual(metadata.text("requestedBy"), "Eva")
        XCTAssertEqual(metadata.text("status"), "approved")
        XCTAssertNil(WorkflowRequest(metadata: metadata, action: "approve", scope: "dm", chatID: 4, messageID: 8))
        XCTAssertEqual(message.body, "Found server")
    }
    func testWorkflowRequestsMatchExistingServerContract() throws {
        let metadata = try JSONDecoder().decode([String: CardValue].self, from: Data(#"{"cardType":"decom_precheck_task","changeId":61,"status":"pending","taskId":44,"taskDescription":"DNS cleanup"}"#.utf8))
        let request = try XCTUnwrap(WorkflowRequest(metadata: metadata, action: "complete", scope: "channel", chatID: 7, messageID: 9))
        XCTAssertEqual(request.path, "/api/decom/61/precheck-task")
        XCTAssertEqual(request.body["action"] as? String, "complete")
        XCTAssertEqual(request.body["channel_id"] as? Int, 7)
        XCTAssertNil(request.body["conversation_id"])
        XCTAssertEqual(request.body["message_id"] as? Int, 9)
        XCTAssertEqual(request.body["task_id"] as? Double, 44)
        XCTAssertNil(WorkflowRequest(metadata: metadata, action: "confirm-destroy", scope: "channel", chatID: 7, messageID: 9))
        let dm = try XCTUnwrap(WorkflowRequest(metadata: ["cardType": .text("decom_approval"), "status": .text("pending"), "changeId": .text("abc/def")], action: "reject", scope: "dm", chatID: 4, messageID: 8))
        XCTAssertEqual(dm.path, "/api/decom/abc%2Fdef/reject")
        XCTAssertEqual(dm.body["conversation_id"] as? Int, 4)
        XCTAssertNil(dm.body["channel_id"])
    }
    func testSummaryPreservesNumericAndNestedMetadataWithoutActions() throws {
        let metadata = try JSONDecoder().decode([String: CardValue].self, from: Data(#"{"cardType":"decom_summary","trackerRow":12,"reclaimed":"4 CPU / 16 GB","elapsedReal":"12 minutes","extension":{"done":true},"tasks":["DNS",null]}"#.utf8))
        XCTAssertEqual(metadata.text("trackerRow"), "12")
        XCTAssertEqual(metadata.text("reclaimed"), "4 CPU / 16 GB")
        XCTAssertEqual(metadata.text("elapsedReal"), "12 minutes")
        XCTAssertNil(WorkflowRequest(metadata: metadata, action: "approve", scope: "dm", chatID: 1, messageID: 1))
    }
}
