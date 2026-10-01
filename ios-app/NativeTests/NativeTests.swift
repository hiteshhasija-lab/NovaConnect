import XCTest
import Security
@testable import NovaConnectNative

@MainActor final class NativeTests: XCTestCase {
    func testServerRequiresHTTPSOriginWithoutCredentials() {
        XCTAssertNil(APIClient.serverURL("http://server.example"))
        XCTAssertNil(APIClient.serverURL("https://user:secret@server.example"))
        XCTAssertNil(APIClient.serverURL("https://server.example/login"))
        XCTAssertNil(APIClient.serverURL("https://server.example?token=x"))
        XCTAssertEqual(APIClient.serverURL("https://server.example:8443/")?.host, "server.example")
    }
    func testSearchIsEncodedAndCannotChangeOrigin() throws {
        let api = APIClient(baseURL: URL(string: "https://server.example")!)
        let url = try api.url("/api/users/search", query: [URLQueryItem(name: "q", value: "Alice & Bob/#?")])
        XCTAssertEqual(url.host, "server.example")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "Alice & Bob/#?")
        XCTAssertThrowsError(try api.url("//attacker.example"))
    }
    func testHydratedMessageContract() throws {
        let data = Data(#"{"messages":[{"id":1,"body":"hello","author":{"id":2,"username":"eva","full_name":"Eva Hasija","status":"online"},"created_at":"2026-09-30 14:00:00","edited":false,"deleted":false,"reactions":[{"emoji":"👍","count":2,"mine":true}],"attachments":[{"id":3,"original_name":"review.pdf","mime_type":"application/pdf","size":100}]}],"has_more":false}"#.utf8)
        let page = try JSONDecoder().decode(MessagePage.self, from: data)
        XCTAssertEqual(page.messages.first?.author.initials, "EH")
        XCTAssertEqual(page.messages.first?.attachments.first?.original_name, "review.pdf")
        XCTAssertEqual(page.messages.first?.reactions.first?.count, 2)
        XCTAssertFalse(page.has_more)
    }
    func testQuotePreservesRemainderAndMultilineContent() {
        let quote = QuotedBody("> Eva 9/30/26 10:00 AM\n> Original\n\nResponse\nSecond line")
        XCTAssertEqual(quote.quote, "Eva 9/30/26 10:00 AM\nOriginal")
        XCTAssertEqual(quote.body, "Response\nSecond line")
        XCTAssertEqual(QuotedBody("Normal > message").body, "Normal > message")
    }
    func testSocketEventsIgnoreControlAndMalformedFrames() {
        XCTAssertNil(LiveEvent.parse("2"))
        XCTAssertNil(LiveEvent.parse("42not-json"))
        let event = LiveEvent.parse(#"42["presence:update",{"userId":7,"status":"dnd"}]"#)
        XCTAssertEqual(event?.name, "presence:update")
        XCTAssertEqual(event?.payload["status"] as? String, "dnd")
    }
    func testChatPreviewIdentifiesSenderAndUsesReplyBody() throws {
        let message = try JSONDecoder().decode(PreviewMessage.self, from: Data(#"{"user_id":7,"author_name":"Eva Hasija","body":"> Original message\n\nHello"}"#.utf8))
        XCTAssertEqual(message.summary(currentUserID: 7), "You: Hello")
        XCTAssertEqual(message.summary(currentUserID: 8), "Eva Hasija: Hello")
        let deleted = try JSONDecoder().decode(PreviewMessage.self, from: Data(#"{"user_id":7,"author_name":"Eva Hasija","deleted":1,"body":"secret"}"#.utf8))
        XCTAssertEqual(deleted.summary(currentUserID: 8), "Eva Hasija: This message was deleted")
        let file = try JSONDecoder().decode(PreviewMessage.self, from: Data(#"{"user_id":7,"author_name":"Eva Hasija","body":""}"#.utf8))
        XCTAssertEqual(file.summary(currentUserID: 7), "You: Attachment")
    }
    func testCallAcknowledgementContract() {
        let ack = SocketAcknowledgement.parse(#"4312[{"ok":true,"id":"call-id"}]"#)
        XCTAssertEqual(ack?.id, 12)
        XCTAssertEqual(ack?.payload["id"] as? String, "call-id")
        XCTAssertNil(SocketAcknowledgement.parse("43[]"))
        XCTAssertNil(SocketAcknowledgement.parse("431[]"))
        XCTAssertNil(SocketAcknowledgement.parse("42[\"presence:update\",{}]"))
        XCTAssertEqual(SocketAcknowledgement.parse(#"433[{"ok":false,"error":"Offline"}]"#)?.payload["ok"] as? Bool, false)
    }
    func testIncomingAudioCallEndsOnlyForMatchingCall() async {
        let calls = NativeCalls(system: FakeSystemCalls()), live = LiveConnection()
        calls.event(LiveEvent(name: "gcall:incoming", payload: ["id": "a", "title": "Eva", "mode": "audio"]), live: live)
        XCTAssertTrue(calls.visible); XCTAssertTrue(calls.incoming)
        XCTAssertEqual(calls.title, "Eva")
        calls.event(LiveEvent(name: "gcall:ended", payload: ["id": "other"]), live: live)
        XCTAssertTrue(calls.visible)
        calls.event(LiveEvent(name: "gcall:ended", payload: ["id": "a"]), live: live)
        XCTAssertFalse(calls.visible); XCTAssertFalse(calls.incoming)
    }
    func testCallDisconnectClearsIncomingControls() {
        let calls = NativeCalls(system: FakeSystemCalls()), live = LiveConnection()
        calls.event(LiveEvent(name: "gcall:incoming", payload: ["id": "a", "mode": "audio"]), live: live)
        calls.disconnected()
        XCTAssertFalse(calls.incoming)
        XCTAssertNotNil(calls.error)
        XCTAssertEqual(calls.phase, "Call ended")
    }
    func testChatLastSeenUsesTimestampAndCurrentPresence() throws {
        var person = try JSONDecoder().decode(Person.self, from: Data(#"{"id":2,"username":"eva","full_name":"Eva","status":"offline","last_seen_at":"2026-10-01 15:00:00"}"#.utf8))
        XCTAssertTrue(person.chatPresence.hasPrefix("Last seen "))
        XCTAssertNotEqual(person.chatPresence, "Last seen unavailable")
        person.status = "online"
        XCTAssertEqual(person.chatPresence, "Available now")
        person.status = "offline"; person.last_seen_at = "invalid"
        XCTAssertEqual(person.chatPresence, "Last seen unavailable")
        person.last_seen_at = nil
        XCTAssertEqual(person.chatPresence, "Last seen unavailable")
    }
    func testUTCDateDecoding() {
        XCTAssertNotNil(Timeline.date("2026-09-30 14:00:00"))
        XCTAssertNil(Timeline.date("not a date"))
    }
    func testLabTrustRejectsWrongHostAndExpiredCertificate() throws {
        let bundle = Bundle(for: NativeTests.self)
        let leaf = try XCTUnwrap(SecCertificateCreateWithData(nil, Data(contentsOf: XCTUnwrap(bundle.url(forResource: "LabServer", withExtension: "der"))) as CFData))
        let root = try XCTUnwrap(SecCertificateCreateWithData(nil, Data(contentsOf: XCTUnwrap(bundle.url(forResource: "LabCA", withExtension: "der"))) as CFData))
        func trust() throws -> SecTrust {
            var result: SecTrust?
            XCTAssertEqual(SecTrustCreateWithCertificates([leaf] as CFArray, SecPolicyCreateSSL(true, "novaconnect.lab.sps" as CFString), &result), errSecSuccess)
            return try XCTUnwrap(result)
        }
        let valid = try trust()
        SecTrustSetVerifyDate(valid, Date(timeIntervalSince1970: 1790812800) as CFDate)
        XCTAssertTrue(SameOriginDelegate.evaluateLabTrust(valid, host: "novaconnect.lab.sps", anchor: root))
        XCTAssertFalse(SameOriginDelegate.evaluateLabTrust(try trust(), host: "attacker.example", anchor: root))
        XCTAssertFalse(SameOriginDelegate.labHost("novaconnect.lab.sps.attacker.example"))
        let expired = try trust()
        SecTrustSetVerifyDate(expired, Date(timeIntervalSince1970: 1924992000) as CFDate)
        XCTAssertFalse(SameOriginDelegate.evaluateLabTrust(expired, host: "novaconnect.lab.sps", anchor: root))
    }
}
