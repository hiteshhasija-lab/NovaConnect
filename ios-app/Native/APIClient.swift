import Foundation
import Security
import UniformTypeIdentifiers

struct APIError: LocalizedError {
    let message: String
    var statusCode: Int? = nil
    var errorDescription: String? { message }
}

// Credentials and cookies must never follow a redirect to a different server.
final class SameOriginDelegate: NSObject, URLSessionTaskDelegate {
    static func labHost(_ host: String) -> Bool {
        ["novaconnect.lab.sps", "10.0.0.102"].contains(host.lowercased())
    }
    static func evaluateLabTrust(_ trust: SecTrust, host: String, anchor: SecCertificate) -> Bool {
        guard labHost(host),
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else { return false }
        return SecTrustEvaluateWithError(trust, nil)
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              Self.labHost(challenge.protectionSpace.host) else {
            completionHandler(.performDefaultHandling, nil); return
        }
        guard let trust = challenge.protectionSpace.serverTrust,
              let file = Bundle.main.url(forResource: "NovaConnectLabCA", withExtension: "der"),
              let data = try? Data(contentsOf: file),
              let anchor = SecCertificateCreateWithData(nil, data as CFData),
              Self.evaluateLabTrust(trust, host: challenge.protectionSpace.host, anchor: anchor) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // API endpoints return JSON, not redirects. This also catches revoked sessions redirected to login.
        completionHandler(nil)
    }
}

@MainActor final class APIClient {
    let baseURL: URL
    let session: URLSession
    init(baseURL: URL, configuration: URLSessionConfiguration? = nil) {
        self.baseURL = baseURL
        let config = configuration ?? URLSessionConfiguration.ephemeral
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 25
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: SameOriginDelegate(), delegateQueue: nil)
    }
    static func serverURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        return url
    }
    func url(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError(message: "Invalid server address.")
        }
        c.path = path; c.queryItems = query.isEmpty ? nil : query
        guard let url = c.url else { throw APIError(message: "Invalid request.") }
        return url
    }
    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, query: [URLQueryItem] = []) throws -> URLRequest {
        var r = URLRequest(url: try url(path, query: query))
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return r
    }
    func data(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError(message: "Invalid server response.") }
        let loginRedirect = (300..<400).contains(response.statusCode) && response.value(forHTTPHeaderField: "Location").flatMap { URL(string: $0, relativeTo: baseURL)?.path } == "/login"
        if response.statusCode == 401 || loginRedirect {
            if request.url?.path != "/api/mobile/login" { NotificationCenter.default.post(name: .sessionExpired, object: self) }
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw APIError(message: json?["error"] as? String ?? "Sign in again to continue.", statusCode: 401)
        }
        guard (200..<300).contains(response.statusCode) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw APIError(message: json?["error"] as? String ?? "The server could not complete the request (\(response.statusCode)).", statusCode: response.statusCode)
        }
        return data
    }
    func get<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil, query: [URLQueryItem] = []) async throws -> T {
        let data = try await data(request(path, method: method, body: body, query: query))
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError(message: "This server response is not supported. The native mobile API must be installed on your server.") }
    }
    func send(_ path: String, method: String = "POST", body: [String: Any] = [:]) async throws {
        _ = try await data(request(path, method: method, body: body))
    }
    func upload(_ path: String, text: String, file: URL) async throws {
        let access = file.startAccessingSecurityScopedResource()
        defer { if access { file.stopAccessingSecurityScopedResource() } }
        let attrs = try file.resourceValues(forKeys: [.fileSizeKey])
        guard (attrs.fileSize ?? 0) <= 20 * 1024 * 1024 else { throw APIError(message: "Choose a file smaller than 20 MB.") }
        let fileData = try Data(contentsOf: file)
        let boundary = UUID().uuidString
        var r = try request(path, method: "POST")
        r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let filename = file.lastPathComponent.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"body\"\r\n\r\n\(text)\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8)
        body.append(fileData); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        r.httpBody = body
        _ = try await data(r)
    }
    func clearCookies() {
        for cookie in HTTPCookieStorage.shared.cookies(for: baseURL) ?? [] { HTTPCookieStorage.shared.deleteCookie(cookie) }
    }
}
extension Notification.Name {
    static let sessionExpired = Notification.Name("native.sessionExpired")
    static let liveUpdate = Notification.Name("native.liveUpdate")
}
