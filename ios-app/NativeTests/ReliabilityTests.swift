import XCTest
@testable import NovaConnectNative

private final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor final class ReliabilityTests: XCTestCase {
    private func api() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return APIClient(baseURL: URL(string: "https://fixture.invalid")!, configuration: config)
    }
    private func page(_ ids: [Int], body: String = "message", more: Bool = false) throws -> Data {
        let messages = ids.map { id in
            ["id": id, "body": body, "author": ["id": 2, "username": "test", "full_name": "Test Person", "status": "online"], "created_at": "2026-09-30 14:00:00", "edited": false, "deleted": false, "reactions": [], "attachments": []] as [String: Any]
        }
        return try JSONSerialization.data(withJSONObject: ["messages": messages, "has_more": more])
    }
    func testMergeDeduplicatesAndUpdatesExistingMessage() throws {
        let first = try JSONDecoder().decode(MessagePage.self, from: page([1, 2]))
        let next = try JSONDecoder().decode(MessagePage.self, from: page([2, 3], body: "edited"))
        let merged = MessageHistory.merge(first.messages, next.messages)
        XCTAssertEqual(merged.map(\.id), [1, 2, 3])
        XCTAssertEqual(merged[1].body, "edited")
    }
    func testReconnectFillsGapAndRefreshesOlderLoadedMessages() async throws {
        let newest = try page([5, 6], more: true)
        let middle = try page([3, 4], more: true)
        let oldest = try page([1, 2], body: "updated")
        StubProtocol.handler = { request in
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
            switch cursor {
            case nil: return (200, newest)
            case "5": return (200, middle)
            case "3": return (200, oldest)
            default: throw APIError(message: "Unexpected cursor")
            }
        }
        let current = try JSONDecoder().decode(MessagePage.self, from: page([1, 2]))
        let refreshed = try await MessageHistory.refresh(api: api(), path: "/api/dm/1/messages", current: current.messages)
        XCTAssertEqual(refreshed.messages.map(\.id), [1, 2, 3, 4, 5, 6])
        XCTAssertEqual(refreshed.messages.first?.body, "updated")
        XCTAssertFalse(refreshed.has_more)
    }
    func testBrokenPaginationFailsInsteadOfLooping() async throws {
        let data = try page([3, 4], more: true)
        StubProtocol.handler = { _ in (200, data) }
        let current = try JSONDecoder().decode(MessagePage.self, from: page([1]))
        do {
            _ = try await MessageHistory.refresh(api: api(), path: "/api/dm/1/messages", current: current.messages)
            XCTFail("Expected invalid cursor error")
        } catch { XCTAssertTrue(error.localizedDescription.contains("earlier messages")) }
    }
    func testForbiddenDoesNotExpireSession() async throws {
        StubProtocol.handler = { _ in (403, Data(#"{"error":"No access"}"#.utf8)) }
        let client = api()
        var expired = false
        let observer = NotificationCenter.default.addObserver(forName: .sessionExpired, object: nil, queue: nil) { _ in expired = true }
        defer { NotificationCenter.default.removeObserver(observer) }
        do { try await client.send("/api/dm/1/read"); XCTFail("Expected forbidden") }
        catch { XCTAssertEqual((error as? APIError)?.statusCode, 403) }
        XCTAssertFalse(expired)
    }
    func testExpiredSessionIdentifiesOriginatingClient() async throws {
        StubProtocol.handler = { _ in (401, Data()) }
        let client = api()
        var source: APIClient?
        let observer = NotificationCenter.default.addObserver(forName: .sessionExpired, object: nil, queue: nil) { source = $0.object as? APIClient }
        defer { NotificationCenter.default.removeObserver(observer) }
        do { try await client.send("/api/dm/1/read"); XCTFail("Expected unauthorized") } catch {}
        XCTAssertTrue(source === client)
    }
    func testReadingClearsUnreadPreferenceAfterReceipt() async throws {
        let receipt = expectation(description: "read receipt")
        let preference = expectation(description: "unread cleared")
        StubProtocol.handler = { request in
            var data = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count))
                }
            }
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            if request.url?.path == "/api/dm/7/read" {
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(body?["message_id"] as? Int, 42)
                receipt.fulfill()
            } else {
                XCTAssertEqual(request.url?.path, "/api/dm/7/preferences")
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(body?["is_unread"] as? Bool, false)
                preference.fulfill()
            }
            return (200, Data("{}".utf8))
        }
        try await api().markConversationRead(7, through: 42)
        await fulfillment(of: [receipt, preference], timeout: 1, enforceOrder: true)
    }
    func testAttachmentFilenameCannotEscapeCache() throws {
        let file = try AttachmentCache.write(Data("test".utf8), filename: "../../outside.txt")
        XCTAssertEqual(file.lastPathComponent, "outside.txt")
        XCTAssertTrue(file.path.hasPrefix(AttachmentCache.directory.path + "/"))
        XCTAssertEqual(try Data(contentsOf: file), Data("test".utf8))
        AttachmentCache.remove(file)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
}
