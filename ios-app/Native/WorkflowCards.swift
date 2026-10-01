import SwiftUI

// Preserve arbitrary server metadata, including numeric IDs and unrelated future cards.
indirect enum CardValue: Decodable {
    case text(String), number(Double), bool(Bool), object([String: CardValue]), array([CardValue]), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(String.self) { self = .text(v) }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: CardValue].self) { self = .object(v) }
        else { self = .array(try c.decode([CardValue].self)) }
    }
    var text: String {
        switch self { case .text(let s): return s; case .number(let n): return n.rounded() == n ? String(format: "%.0f", n) : String(n); default: return "" }
    }
}
extension Dictionary where Key == String, Value == CardValue {
    func text(_ key: String) -> String { self[key]?.text ?? "" }
}
struct WorkflowRequest {
    let path: String
    let body: [String: Any]
    init?(metadata: [String: CardValue], action: String, scope: String, chatID: Int, messageID: Int) {
        guard metadata.text("status") == "pending" else { return nil }
        let type = metadata.text("cardType")
        let allowed: [String: [String]] = ["decom_approval": ["approve", "reject"], "decom_confirm_destroy": ["confirm-destroy", "cancel-destroy"], "decom_skip_manual_tasks": ["skip-manual-tasks"], "decom_precheck_task": ["complete", "skip"]]
        guard allowed[type]?.contains(action) == true, !metadata.text("changeId").isEmpty,
              let id = metadata.text("changeId").addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) else { return nil }
        path = "/api/decom/\(id)/\(type == "decom_precheck_task" ? "precheck-task" : action)"
        var values: [String: Any] = ["message_id": messageID, scope == "dm" ? "conversation_id" : "channel_id": chatID]
        if type == "decom_precheck_task" {
            values["action"] = action; values["task_description"] = metadata.text("taskDescription")
            if case .number(let id) = metadata["taskId"] { values["task_id"] = id }
            else if !metadata.text("taskId").isEmpty { values["task_id"] = metadata.text("taskId") }
        }
        body = values
    }
}
struct WorkflowCard: View {
    @EnvironmentObject private var session: AppSession
    let metadata: [String: CardValue]
    let messageID: Int
    let scope: String
    let chatID: Int
    let refresh: () async -> Void
    @State private var busy = false
    @State private var submitted = false
    @State private var failure: String?
    @State private var confirmation: String?
    private var type: String { metadata.text("cardType") }
    private var status: String { metadata.text("status") }
    private var pending: Bool { status == "pending" }
    private var supported: Bool { ["decom_approval", "decom_confirm_destroy", "decom_skip_manual_tasks", "decom_precheck_task", "decom_summary"].contains(type) }
    var body: some View {
        if supported {
            VStack(alignment: .leading, spacing: 12) {
                switch type {
                case "decom_approval":
                    Text("\(metadata.text("changeNumber")) — Decommission \(metadata.text("ciName"))").font(.headline)
                    if !metadata.text("ciCategory").isEmpty { Text(metadata.text("ciCategory")).foregroundStyle(.secondary) }
                    row("Change Type", metadata.text("changeType")); row("Risk", metadata.text("risk"))
                    row("Scheduled", metadata.text("plannedStart").isEmpty ? "—" : Timeline.label(metadata.text("plannedStart")))
                    row("Requested by", metadata.text("requestedBy")); row("Assignment Group", metadata.text("assignmentGroup")); row("Assigned To", metadata.text("assignedTo"))
                    HStack {
                        action(status == "approved" ? "Approved" : "Approve", "approve")
                        action(status == "rejected" ? "Rejected" : "Reject", "reject", destructive: true)
                    }
                    if let url = URL(string: metadata.text("novadeskChangeUrl")), ["https", "http"].contains(url.scheme?.lowercased() ?? "") { Link("View Change", destination: url) }
                case "decom_summary":
                    Text("\(metadata.text("ciName")) decommissioned").font(.headline)
                    row("Change", metadata.text("changeNumber") + " — " + metadata.text("changeStatus"))
                    row("CMDB", metadata.text("cmdbStatus")); row("Reclaimed", metadata.text("reclaimed"))
                    row("Tracker", metadata.text("trackerRow").isEmpty ? "—" : "Row \(metadata.text("trackerRow")) appended")
                    row("Elapsed", metadata.text("elapsedReal"))
                case "decom_precheck_task":
                    Text(metadata.text("taskDescription").isEmpty ? metadata.text("taskNumber") : metadata.text("taskDescription")).font(.headline)
                    if pending { HStack { action("Complete", "complete"); action("Skip", "skip") } }
                    else { Text(["completed", "done"].contains(status) ? "Completed" : status.capitalized).font(.subheadline.bold()) }
                case "decom_skip_manual_tasks":
                    Text("Pre-decommission checks").font(.headline)
                    if case .array(let tasks) = metadata["tasks"] { ForEach(Array(tasks.enumerated()), id: \.offset) { _, task in Text("• " + task.text) } }
                    if pending { action("Skip all", "skip-manual-tasks") } else { Text("Marked as handled / skipped") }
                case "decom_confirm_destroy":
                    Text("\(metadata.text("changeNumber")) — \(metadata.text("ciName"))").font(.headline)
                    if pending {
                        Text("This permanently destroys the VM and releases its storage. This cannot be undone.").foregroundStyle(.red)
                        action("Confirm Destroy", "confirm-destroy", destructive: true)
                        action("Cancel and power back on", "cancel-destroy")
                    } else { Text(status == "cancelled" ? "Cancelled — powered back on" : status.capitalized).font(.subheadline.bold()) }
                default: EmptyView()
                }
                if busy { ProgressView("Submitting…") }
                else if submitted && pending { Text("Submitted. Waiting for the workflow update…").font(.caption) }
                if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                .confirmationDialog(confirmation == "confirm-destroy" ? "Permanently destroy \(metadata.text("ciName"))? This cannot be undone." : "Cancel destruction and power the VM back on?", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
                    if let confirmation { Button(confirmation == "confirm-destroy" ? "Permanently destroy" : "Power back on", role: confirmation == "confirm-destroy" ? .destructive : nil) { Task { await submit(confirmation) } } }
                    Button("Keep current state", role: .cancel) {}
                }
        }
    }
    private func row(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value.isEmpty ? "—" : value).font(.subheadline).textSelection(.enabled)
        }
    }
    private func action(_ label: String, _ action: String, destructive: Bool = false) -> some View {
        Button(label) {
            if ["confirm-destroy", "cancel-destroy"].contains(action) { confirmation = action }
            else { Task { await submit(action) } }
        }.novaGlassButtons().tint(destructive ? .red : .blue)
            .disabled(!pending || busy || submitted || metadata.text("changeId").isEmpty)
    }
    private func submit(_ action: String) async {
        guard !busy, !submitted, let api = session.api,
              let request = WorkflowRequest(metadata: metadata, action: action, scope: scope, chatID: chatID, messageID: messageID) else { return }
        busy = true; failure = nil
        defer { busy = false }
        do {
            try await api.send(request.path, body: request.body)
            submitted = true
            await refresh()
        } catch { failure = error.localizedDescription; await refresh() }
    }
}
struct BotThinkingBubble: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.25, paused: reduceMotion)) { context in
            HStack(spacing: 6) {
                ForEach(0..<3) { index in
                    Circle().fill(Color.blue).frame(width: 7, height: 7)
                        .opacity(reduceMotion ? 0.7 : (Int(context.date.timeIntervalSinceReferenceDate * 4) % 3 == index ? 1 : 0.3))
                }
            }.padding(14).background(Color.blue.opacity(0.12), in: Capsule())
        }.accessibilityElement(children: .ignore).accessibilityLabel("NovaDesk is processing your request")
    }
}
