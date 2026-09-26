import SwiftUI

struct RootView: View {
    @EnvironmentObject private var settings: ServerSettings
    @State private var loadState: LoadState = .loading
    @State private var reloadToken = UUID()
    @State private var showingSettings = false

    var body: some View {
        Group {
            if let url = settings.serverURL {
                ZStack {
                    WebView(url: url, reloadToken: reloadToken, loadState: $loadState)
                        .ignoresSafeArea(edges: .bottom)
                    switch loadState {
                    case .loading:
                        ProgressView().controlSize(.large)
                    case .failed(let message):
                        ErrorView(url: url, message: message,
                                  retry: { reloadToken = UUID() },
                                  changeServer: { showingSettings = true })
                    case .loaded:
                        EmptyView()
                    }
                }
            } else {
                // No saved address and no build-time default: ask for one.
                SettingsView(canCancel: false)
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView(canCancel: true, onSave: { reloadToken = UUID() })
        }
    }
}

struct ErrorView: View {
    let url: URL
    let message: String
    let retry: () -> Void
    let changeServer: () -> Void

    var body: some View {
        ZStack {
            Color(.systemGroupedBackground).ignoresSafeArea()
            VStack(spacing: 12) {
                Image("Logo")
                    .resizable()
                    .frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                Text("Can't reach NovaConnect")
                    .font(.title3.bold())
                    .foregroundStyle(Color.accentColor)
                Text("Couldn't connect to \(url.absoluteString)")
                    .font(.subheadline.monospaced())
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Text("Check that the server is running and this device is on the same network, or change the server address.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                HStack(spacing: 12) {
                    Button("Change server", action: changeServer)
                        .buttonStyle(.bordered)
                    Button("Try again", action: retry)
                        .buttonStyle(.borderedProminent)
                }
                .padding(.top, 8)
            }
            .padding(28)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
            .padding(24)
        }
    }
}

struct SettingsView: View {
    let canCancel: Bool
    var onSave: () -> Void = {}
    @EnvironmentObject private var settings: ServerSettings
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://novaconnect.example.com", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(save)
                } header: {
                    Text("Server address")
                } footer: {
                    if let error { Text(error).foregroundStyle(.red) }
                    else { Text("The address of your organization's NovaConnect server.") }
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if canCancel {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Connect", action: save) }
            }
            .onAppear { address = settings.serverURL?.absoluteString ?? "" }
        }
    }

    private func save() {
        guard let url = ServerSettings.parse(address) else {
            error = "Enter a full address starting with http:// or https://"
            return
        }
        settings.serverURL = url
        onSave()
        dismiss()
    }
}
