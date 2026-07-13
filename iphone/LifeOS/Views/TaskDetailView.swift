import SwiftUI

struct TaskDetailView: View {
    let task: LifeTask
    let detail: TaskDetail?

    var body: some View {
        ScrollView {
            if let detail {
                LazyVStack(alignment: .leading, spacing: 26) {
                    hero(detail)
                    outcomeSection(detail)

                    if let commentary = detail.agentCommentary {
                        commentarySection(commentary)
                    }

                    vaultSection(detail.vaultContext)
                    provenanceNote
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            } else {
                ContentUnavailableView(
                    "Details unavailable",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text("This preview has no sanitized detail projection for the task.")
                )
                .padding(.top, 80)
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func hero(_ detail: TaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 8) {
                StatusPill(title: task.project, symbol: "folder", color: .blue)
                StatusPill(
                    title: task.priority.rawValue,
                    symbol: "flag.fill",
                    color: priorityColor
                )
            }

            Text(task.title)
                .font(.largeTitle.bold())
                .fixedSize(horizontal: false, vertical: true)

            Text(detail.summary)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(task.isComplete ? "Complete" : "Progress")
                        .font(.caption.weight(.semibold))
                    Spacer()
                    Text(detail.progress, format: .percent.precision(.fractionLength(0)))
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.secondary)
                }

                ProgressView(value: detail.progress)
                    .tint(task.isComplete ? .green : Color.accentColor)
            }
        }
        .padding(.top, 14)
    }

    private func outcomeSection(_ detail: TaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("At a glance", symbol: "scope")

            SurfaceCard {
                VStack(alignment: .leading, spacing: 20) {
                    detailRow(
                        label: "Intended outcome",
                        value: detail.intendedOutcome,
                        symbol: "target"
                    )

                    Divider()

                    detailRow(
                        label: "Next step",
                        value: detail.nextStep,
                        symbol: "arrow.forward.circle"
                    )
                }
            }
        }
    }

    private func commentarySection(_ commentary: AgentCommentary) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("LifeOS perspective", symbol: "sparkles")

            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Label("AGENT COMMENTARY", systemImage: "wand.and.stars")
                        .font(.caption.bold())
                        .tracking(0.7)
                    Spacer()
                    Image(systemName: "quote.opening")
                        .font(.title2)
                        .opacity(0.45)
                }

                Text(commentary.headline)
                    .font(.title3.bold())

                Text(commentary.body)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)

                if !commentary.suggestions.isEmpty {
                    VStack(alignment: .leading, spacing: 11) {
                        ForEach(commentary.suggestions, id: \.self) { suggestion in
                            Label(suggestion, systemImage: "arrow.right.circle.fill")
                                .font(.subheadline)
                        }
                    }
                }

                Text(commentary.generatedLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .foregroundStyle(.white)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(
                    colors: [Color.indigo, Color.purple],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                in: RoundedRectangle(cornerRadius: 20, style: .continuous)
            )
            .shadow(color: Color.indigo.opacity(0.18), radius: 16, y: 7)
        }
    }

    private func vaultSection(_ context: [TaskContextItem]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionTitle("From your vault", symbol: "books.vertical")

            ForEach(context) { item in
                SurfaceCard {
                    HStack(alignment: .top, spacing: 13) {
                        Image(systemName: item.symbol)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 38, height: 38)
                            .background(Color.accentColor.opacity(0.11), in: Circle())
                            .accessibilityHidden(true)

                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.sourceLabel.uppercased())
                                .font(.caption2.bold())
                                .tracking(0.6)
                                .foregroundStyle(Color.accentColor)

                            Text(item.title)
                                .font(.headline)

                            Text(item.summary)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)

                            Text(item.updatedLabel)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private var provenanceNote: some View {
        Label(
            "This screen uses a sanitized projection. It exposes no vault path, raw excerpt, provider identifier, or source hash.",
            systemImage: "lock.shield"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
    }

    private func detailRow(label: String, value: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(Color.accentColor)
                .frame(width: 24)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.body.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func sectionTitle(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.title2.bold())
    }

    private var priorityColor: Color {
        switch task.priority {
        case .high: .orange
        case .normal: .blue
        case .low: .secondary
        }
    }
}

#Preview {
    NavigationStack {
        TaskDetailView(
            task: AppModel.preview.tasks[0],
            detail: AppModel.preview.detail(for: AppModel.preview.tasks[0])
        )
    }
}
