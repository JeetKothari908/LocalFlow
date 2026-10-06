import Combine
import SwiftUI
import UIKit
import WebKit

@MainActor
final class MobileWebCoordinator: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    @Published var selectedTab = 0
    @Published var settingsOpen = false
    @Published var shareURL: URL?
    @Published var loadError: String?
    @Published private(set) var webGeneration = 0
    private(set) var webView: WKWebView!
    private let store: SyncStore
    private var subscription: AnyCancellable?
    private var ready = false
    private let routes = MobileRouteState()
    private var pendingRoute: (id: String, taskId: String)? { routes.pending }
    private var rootURL: URL?
    private var broadcasting = false
    private var snapshotQueued = false

    init(store: SyncStore) {
        self.store = store
        super.init()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addScriptMessageHandler(WeakMobileHandler(self), contentWorld: .page, name: "localflow")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        subscription = store.objectWillChange.sink { [weak self] _ in
            // Published properties notify before mutation. Broadcast the coherent
            // snapshot on the next main-loop turn, after persistence has finished.
            self?.scheduleSnapshot()
        }
        selectedTab = routes.pending == nil ? routes.lastTab : 0
        load()
    }

    func load() {
        ready = false; loadError = nil
        guard let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "MobileWeb") else {
            loadError = "The mobile interface is missing from this build. Run npm run build:mobile before building in Xcode."
            return
        }
        rootURL = url.deletingLastPathComponent().standardizedFileURL
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func selectTab(_ index: Int) {
        selectedTab = index
        routes.selectTab(index)
        if index < 3 {
            sendRoute()
        }
    }

    func openTask(_ id: String) {
        selectedTab = 0
        routes.openTask(id)
        sendRoute()
    }

    private func sendRoute() {
        guard ready, selectedTab < 3 else { return }
        var payload: [String: Any] = ["route": ["tasks", "notes", "plan"][selectedTab]]
        if let pendingRoute { payload["route"] = "tasks"; payload["taskId"] = pendingRoute.taskId; payload["eventId"] = pendingRoute.id }
        else if selectedTab == 0, let task = routes.lastTask { payload["taskId"] = task }
        emit("localflow:route", payload: payload)
    }

    private func emit(_ name: String, payload: Any) {
        guard ready else { return }
        // Values are passed as arguments, never interpolated into executable JS.
        webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent(eventName, {detail: payload}));", arguments: ["eventName": name, "payload": payload], in: nil, in: .page) { _ in }
    }

    private func publishSnapshot() {
        guard ready, !broadcasting else { return }
        broadcasting = true
        defer { broadcasting = false }
        do { emit("localflow:snapshot", payload: try object(store.mobileSnapshot())) }
        catch { loadError = error.localizedDescription }
    }

    private func scheduleSnapshot() {
        guard !snapshotQueued else { return }
        snapshotQueued = true
        DispatchQueue.main.async { [weak self] in
            self?.snapshotQueued = false
            self?.publishSnapshot()
        }
    }

    private func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: .fragmentsAllowed)
    }

    private func prepareShare(_ data: Data, filename: String) throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("LocalFlow-Exports", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safeName = URL(fileURLWithPath: filename).lastPathComponent
        let url = folder.appendingPathComponent(safeName.isEmpty ? "localflow-export.json" : String(safeName.prefix(160)))
        try data.write(to: url, options: .atomic)
        shareURL = url
    }

    private func documentKey(_ body: [String: Any]) throws -> MobileDocumentKey {
        guard let value = body["key"] as? String, let key = MobileDocumentKey(rawValue: value) else { throw MobileDocumentError.invalid("Unknown document.") }
        return key
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.webView === webView,
              let source = message.frameInfo.request.url, source.isFileURL,
              source.deletingLastPathComponent().standardizedFileURL.path == rootURL?.path,
              let body = message.body as? [String: Any], body["protocol"] as? Int == 1,
              let method = body["method"] as? String else { replyHandler(nil, "Untrusted bridge request."); return }
        Task { @MainActor in
            do {
                let result: Any
                switch method {
                case "snapshot": result = try object(store.mobileSnapshot())
                case "ready":
                    ready = true
                    webGeneration += 1
                    if let id = store.taskToOpen, pendingRoute == nil { openTask(id) } else { sendRoute() }
                    result = ["ok": true]
                case "commit":
                    let encoded = try JSONSerialization.data(withJSONObject: body)
                    guard encoded.count < 32 * 1024 * 1024 else { throw MobileDocumentError.invalid("This document is too large to save.") }
                    result = try object(store.commitMobile(JSONDecoder().decode(MobileCommit.self, from: encoded)))
                case "resolveDraft":
                    guard let useLocal = body["useLocal"] as? Bool else { throw MobileDocumentError.invalid("Choose a draft resolution.") }
                    let encoded = try JSONSerialization.data(withJSONObject: body)
                    guard encoded.count < 32 * 1024 * 1024 else { throw MobileDocumentError.invalid("This draft is too large to save.") }
                    result = try object(store.commitMobile(JSONDecoder().decode(MobileCommit.self, from: encoded), draftDecision: useLocal))
                case "preserveDraft":
                    let key = try documentKey(body)
                    guard let value = body["value"] else { throw MobileDocumentError.invalid("Missing draft.") }
                    let data = try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
                    guard data.count < 32 * 1024 * 1024 else { throw MobileDocumentError.invalid("Draft is too large.") }
                    try store.preserveMobileDraft(key, value: JSONDecoder().decode(JSONValue.self, from: data)); result = ["ok": true]
                case "discardDraft": try store.discardMobileDraft(documentKey(body)); result = ["ok": true]
                case "refresh": await store.refresh(); result = try object(store.mobileSnapshot())
                case "settings": settingsOpen = true; result = ["ok": true]
                case "resolveConflict":
                    guard let useLocal = body["useLocal"] as? Bool else { throw MobileDocumentError.invalid("Choose a conflict resolution.") }
                    try store.resolveMobileConflict(documentKey(body), useLocal: useLocal); result = try object(store.mobileSnapshot())
                case "history": result = try await store.mobileHistory(documentKey(body)).bridgeObject()
                case "restoreRevision":
                    guard let version = body["version"] as? Int, let baseline = body["baseVersion"] as? Int else { throw MobileDocumentError.invalid("Reload revision history and try again.") }
                    let restored = try await store.restoreMobileRevision(documentKey(body), version: version, baseVersion: baseline)
                    result = try object(restored)
                case "exportBackup":
                    let value = try store.mobileBackup(documentKey(body)); let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                    try prepareShare(try encoder.encode(value), filename: "localflow-recovery.json"); result = ["ok": true]
                case "share":
                    guard let text = body["text"] as? String, text.utf8.count < 32 * 1024 * 1024 else { throw MobileDocumentError.invalid("Invalid export.") }
                    try prepareShare(Data(text.utf8), filename: body["filename"] as? String ?? "localflow-export.json"); result = ["ok": true]
                case "copyTaskLink":
                    guard let id = body["id"] as? String, !id.isEmpty else { throw MobileDocumentError.invalid("Missing task.") }
                    var allowed = CharacterSet.urlPathAllowed; allowed.remove(charactersIn: "/?#%")
                    UIPasteboard.general.string = "localflow://task/\(id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id)"; result = ["ok": true]
                case "taskRoute":
                    routes.selectTask(body["id"] as? String)
                    result = ["ok": true]
                case "readEditorDraft":
                    guard let id = body["id"] as? String else { throw MobileDocumentError.invalid("Missing task draft ID.") }
                    result = try store.readMobileEditorDraft(id).bridgeObject()
                case "writeEditorDraft":
                    guard let id = body["id"] as? String else { throw MobileDocumentError.invalid("Missing task draft ID.") }
                    let data = try JSONSerialization.data(withJSONObject: body["value"] ?? NSNull(), options: .fragmentsAllowed)
                    guard data.count < 1024 * 1024 else { throw MobileDocumentError.invalid("The task draft is too large.") }
                    try store.writeMobileEditorDraft(id, value: JSONDecoder().decode(JSONValue.self, from: data))
                    result = ["ok": true]
                case "routeAcknowledged":
                    if let id = body["eventId"] as? String, routes.acknowledge(id) { store.taskToOpen = nil }
                    result = ["ok": true]
                default: throw MobileDocumentError.invalid("Unsupported bridge operation.")
                }
                replyHandler(result, nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.isFileURL, url.deletingLastPathComponent().standardizedFileURL.path == rootURL?.path { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated, ["https", "http", "mailto"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { load() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loadError = error.localizedDescription }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loadError = error.localizedDescription }
}

/// WKUserContentController retains its handler; a weak proxy avoids a webview cycle.
@MainActor
private final class WeakMobileHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: MobileWebCoordinator?
    init(_ target: MobileWebCoordinator) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { replyHandler(nil, "The app has closed."); return }
        target.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
    }
}

struct MobileWebView: UIViewRepresentable {
    let coordinator: MobileWebCoordinator
    func makeUIView(context: Context) -> WKWebView { coordinator.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct MobileShareView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
