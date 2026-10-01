import Foundation
import UIKit

// Engine.IO v4 / Socket.IO default namespace, text events only. Media signaling is not implemented here.
@MainActor final class LiveConnection: ObservableObject {
    @Published var connected = false
    private var socket: URLSessionWebSocketTask?
    private var loop: Task<Void, Never>?
    private var client: APIClient?
    private var generation = UUID()
    private var nextRequestID = 0
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var timeouts: [Int: Task<Void, Never>] = [:]
    func request(_ event: String, _ payload: [String: Any] = [:]) async throws -> [String: Any] {
        guard connected, let socket else { throw APIError(message: "The live connection is unavailable.") }
        nextRequestID += 1
        let id = nextRequestID
        let data = try JSONSerialization.data(withJSONObject: [event, payload])
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            timeouts[id] = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
                self?.finish(id, .failure(APIError(message: "The call request timed out.")))
            }
            Task {
                do { try await socket.send(.string("42\(id)" + String(decoding: data, as: UTF8.self))) }
                catch { finish(id, .failure(error)) }
            }
        }
    }
    private func finish(_ id: Int, _ result: Result<[String: Any], Error>) {
        timeouts.removeValue(forKey: id)?.cancel()
        pending.removeValue(forKey: id)?.resume(with: result)
    }
    private func failPending() {
        for id in Array(pending.keys) { finish(id, .failure(APIError(message: "The call connection closed."))) }
    }

    func start(_ api: APIClient) {
        stop(); client = api
        let token = generation
        loop = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                guard let self, self.generation == token else { return }
                do {
                    var c = URLComponents(url: try api.url("/socket.io/"), resolvingAgainstBaseURL: false)!
                    c.scheme = "wss"
                    c.queryItems = [URLQueryItem(name: "EIO", value: "4"), URLQueryItem(name: "transport", value: "websocket")]
                    var request = URLRequest(url: c.url!)
                    let cookies = HTTPCookieStorage.shared.cookies(for: api.baseURL) ?? []
                    for (key, value) in HTTPCookie.requestHeaderFields(with: cookies) { request.setValue(value, forHTTPHeaderField: key) }
                    let ws = api.session.webSocketTask(with: request)
                    self.socket = ws; ws.resume()
                    while !Task.isCancelled {
                        let message = try await ws.receive()
                        guard self.generation == token, !Task.isCancelled else { return }
                        guard case .string(let text) = message else { continue }
                        if text.hasPrefix("0") { try await ws.send(.string("40")) }
                        else if text.hasPrefix("2") { try await ws.send(.string("3" + text.dropFirst())) }
                        else if text.hasPrefix("40") {
                            self.connected = true; delay = 1
                            NotificationCenter.default.post(name: .liveUpdate, object: nil)
                        } else if let ack = SocketAcknowledgement.parse(text) {
                            if ack.payload["ok"] as? Bool == true { self.finish(ack.id, .success(ack.payload)) }
                            else { self.finish(ack.id, .failure(APIError(message: ack.payload["error"] as? String ?? "Call request failed."))) }
                        } else if let event = LiveEvent.parse(text) {
                            NotificationCenter.default.post(name: .liveUpdate, object: event)
                        } else if text.hasPrefix("44") {
                            NotificationCenter.default.post(name: .sessionExpired, object: api)
                            self.connected = false; return
                        } else if text == "1" || text == "41" { throw APIError(message: "Connection closed.") }
                    }
                } catch {
                    guard self.generation == token, !Task.isCancelled else { return }
                    self.connected = false; self.failPending()
                }
                self.socket?.cancel(with: .goingAway, reason: nil)
                do { try await Task.sleep(nanoseconds: delay * 1_000_000_000) } catch { return }
                delay = min(delay * 2, 30)
            }
        }
    }
    func presence(_ value: String) async throws {
        guard connected, let socket else { throw APIError(message: "Wait until the live connection is restored.") }
        let data = try JSONSerialization.data(withJSONObject: ["presence:set", ["status": value]])
        try await socket.send(.string("42" + String(decoding: data, as: UTF8.self)))
    }
    // Brief execution time only to deliver the lifecycle event, never a keepalive.
    func enterBackground() {
        let token = generation
        let taskID = UIApplication.shared.beginBackgroundTask(withName: "Presence update")
        Task {
            defer { if taskID != .invalid { UIApplication.shared.endBackgroundTask(taskID) } }
            if connected { _ = try? await request("presence:background") }
            guard generation == token else { return }
            stop()
        }
    }
    func stop() {
        generation = UUID(); failPending()
        loop?.cancel(); loop = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        connected = false; client = nil
    }
}
