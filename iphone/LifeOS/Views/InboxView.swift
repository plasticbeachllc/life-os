import SwiftUI

struct InboxView: View {
    let model: AppModel
    @State private var selectedItem: InboxItem?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                filterBar

                if model.filteredInboxItems.isEmpty {
                    ContentUnavailableView(
                        "Nothing here",
                        systemImage: "tray",
                        description: Text("LifeOS has no items in this category.")
                    )
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(model.filteredInboxItems) { item in
                                inboxCard(item)
                            }
                        }
                        .padding(16)
                    }
                    .background(Color(.systemGroupedBackground))
                }
            }
            .navigationTitle("Inbox")
            .sheet(item: $selectedItem) { item in
                InboxDetailView(item: item)
            }
        }
    }

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(InboxFilter.allCases) { filter in
                    Button {
                        model.inboxFilter = filter
                    } label: {
                        Text(filter.rawValue)
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(
                                model.inboxFilter == filter ? Color.accentColor : Color(.secondarySystemFill),
                                in: Capsule()
                            )
                            .foregroundStyle(model.inboxFilter == filter ? .white : .primary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(model.inboxFilter == filter ? .isSelected : [])
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .background(.bar)
    }

    private func inboxCard(_ item: InboxItem) -> some View {
        Button {
            selectedItem = item
        } label: {
            SurfaceCard {
                HStack(alignment: .top, spacing: 13) {
                    Image(systemName: item.symbol)
                        .font(.title3)
                        .foregroundStyle(toneColor(item.tone))
                        .frame(width: 38, height: 38)
                        .background(toneColor(item.tone).opacity(0.12), in: Circle())

                    VStack(alignment: .leading, spacing: 7) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(item.title)
                                .font(.headline)
                                .foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            Text(item.relativeTime)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Text(item.summary)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        if let actionLabel = item.actionLabel {
                            Label(actionLabel, systemImage: "chevron.right")
                                .labelStyle(.titleAndIcon)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens a sanitized preview")
    }

    private func toneColor(_ tone: InboxTone) -> Color {
        switch tone {
        case .question: .blue
        case .receipt: .green
        case .proposal: .orange
        case .update: .purple
        }
    }
}

private struct InboxDetailView: View {
    let item: InboxItem
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(item.summary)
                } header: {
                    Text("Sanitized summary")
                }

                Section("Prototype status") {
                    Label("Read-only preview", systemImage: "lock")
                    Text("No action is submitted and no canonical state is changed.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(item.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    InboxView(model: .preview)
}
