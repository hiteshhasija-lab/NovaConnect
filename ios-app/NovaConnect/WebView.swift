import SwiftUI
import WebKit

enum LoadState: Equatable {
    case loading
    case loaded
    case failed(String)
}

/// Hosts the NovaConnect web app. Reloads whenever `url` or `reloadToken` changes.
struct WebView: UIViewRepresentable {
    let url: URL
    let reloadToken: UUID
    @Binding var loadState: LoadState

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true               // meeting video plays in-page
        config.mediaTypesRequiringUserActionForPlayback = []  // remote participants' audio autoplays
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.loadIfNeeded(webView)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: WebView
        private var loadedURL: URL?
        private var loadedToken: UUID?
        private var timeout: Timer?

        init(_ parent: WebView) { self.parent = parent }

        func loadIfNeeded(_ webView: WKWebView) {
            guard loadedURL != parent.url || loadedToken != parent.reloadToken else { return }
            loadedURL = parent.url
            loadedToken = parent.reloadToken
            setState(.loading)
            // A server address with nothing behind it on the LAN never fails — the connection
            // just hangs — so without a timeout the user would stare at a blank screen.
            timeout?.invalidate()
            timeout = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self, weak webView] _ in
                webView?.stopLoading()
                self?.setState(.failed("The server did not respond within 15 seconds."))
            }
            webView.load(URLRequest(url: parent.url))
        }

        private func setState(_ state: LoadState) {
            if state != .loading { timeout?.invalidate() }
            DispatchQueue.main.async { self.parent.loadState = state }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            setState(.loaded)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        private func fail(_ error: Error) {
            // Cancelled = superseded by another navigation (e.g. a redirect), not a real failure.
            if (error as NSError).code == NSURLErrorCancelled { return }
            setState(.failed(error.localizedDescription))
        }

        private func isConfiguredServer(_ host: String?) -> Bool {
            host != nil && host == parent.url.host
        }

        // On-prem servers often use a self-signed/internal-CA certificate. Trust it only for the
        // server the user configured, never for any other host.
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                     completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
               isConfiguredServer(challenge.protectionSpace.host),
               let trust = challenge.protectionSpace.serverTrust {
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                completionHandler(.performDefaultHandling, nil)
            }
        }

        // Camera/mic for meetings: grant for the NovaConnect server's own pages only.
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(isConfiguredServer(origin.host) ? .grant : .deny)
        }

        // Links that open a new tab/window (e.g. a shared file link) go to Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url { UIApplication.shared.open(url) }
            return nil
        }
    }
}
