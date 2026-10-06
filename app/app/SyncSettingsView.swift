import SwiftUI

struct SyncSettingsView: View {
    @AppStorage("mobile.useSharedInterface") private var useSharedInterface = true
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: SyncStore

    var body: some View {
        NavigationStack {
            Form {
                if MobileInterfaceAvailability.enabled { Section("Interface") {
                    Toggle("Use shared LocalFlow interface", isOn: $useSharedInterface)
                    Text("Switching interfaces keeps the same local data and sync connection.").font(.caption).foregroundStyle(.secondary)
                } }
                Section("Server") {
                    TextField("Sync server URL", text: $store.serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Bearer token", text: $store.authToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section {
                    Button {
                        Task { await store.refresh() }
                    } label: {
                        Label("Sync Now", systemImage: "arrow.clockwise")
                    }
                    .disabled(store.isSyncing)
                }

                Section("Status") {
                    Text(store.status)
                    if let errorMessage = store.errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Sync")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}

struct SyncStatusView: View {
    @EnvironmentObject private var store: SyncStore

    var body: some View {
        VStack(spacing: 4) {
            if let errorMessage = store.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            } else {
                Text(store.status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(.bar)
    }
}
