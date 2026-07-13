import SwiftUI

struct MoreView: View {
    let model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section("Connection") {
                    LabeledContent("Mode") {
                        StatusPill(title: "Preview", symbol: "hammer", color: .blue)
                    }

                    LabeledContent("Access") {
                        StatusPill(title: "Read only", symbol: "lock", color: .green)
                    }

                    LabeledContent("Last sync", value: model.systemStatus.lastSync)
                }

                Section("Sources") {
                    ForEach(model.systemStatus.enabledSources, id: \.self) { source in
                        Label(source, systemImage: symbol(for: source))
                    }
                }

                Section("Privacy boundary") {
                    Label("No provider bodies", systemImage: "eye.slash")
                    Label("No direct vault or database access", systemImage: "externaldrive.badge.xmark")
                    Label("No mutations enabled", systemImage: "hand.raised")
                }

                Section {
                    Text("LifeOS iPhone prototype")
                    LabeledContent("Version", value: "0.1")
                }
            }
            .navigationTitle("More")
        }
    }

    private func symbol(for source: String) -> String {
        switch source {
        case "Obsidian": "doc.text"
        case "Calendar": "calendar"
        case "Gmail": "envelope"
        case "Messages": "message"
        default: "circle.grid.2x2"
        }
    }
}

#Preview {
    MoreView(model: .preview)
}
