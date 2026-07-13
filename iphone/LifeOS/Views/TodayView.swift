import SwiftUI

struct TodayView: View {
    let model: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    header
                    focusCard
                    metrics
                    scheduleSection
                    prioritiesSection
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .background(Color(.systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(model.briefing.greeting)
                    .font(.largeTitle.bold())
                Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button {
                model.selectedTab = .inbox
            } label: {
                Image(systemName: "bell.fill")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .background(.background, in: Circle())
                    .overlay(alignment: .topTrailing) {
                        Text("\(model.briefing.attentionCount)")
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(.red, in: Circle())
                            .offset(x: 2, y: -2)
                    }
                    .shadow(color: .black.opacity(0.06), radius: 8, y: 3)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open inbox, \(model.briefing.attentionCount) items need attention")
        }
        .padding(.top, 10)
    }

    private var focusCard: some View {
        ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color.accentColor, Color.indigo],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            Circle()
                .fill(.white.opacity(0.08))
                .frame(width: 180, height: 180)
                .offset(x: 70, y: -75)
                .accessibilityHidden(true)

            Circle()
                .fill(.white.opacity(0.06))
                .frame(width: 90, height: 90)
                .offset(x: 10, y: 95)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 14) {
                Label("DAILY FOCUS", systemImage: "scope")
                    .font(.caption.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(.white.opacity(0.82))

                Text(model.briefing.focus)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    model.selectedTab = .inbox
                } label: {
                    HStack(spacing: 7) {
                        Text("Review decisions")
                        Spacer()
                        Text("\(model.briefing.attentionCount)")
                            .font(.caption.bold())
                            .frame(minWidth: 24, minHeight: 24)
                            .background(.white.opacity(0.18), in: Circle())
                        Image(systemName: "arrow.right")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
            }
            .padding(20)
        }
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .shadow(color: Color.accentColor.opacity(0.18), radius: 18, y: 8)
        .accessibilityElement(children: .contain)
    }

    private var metrics: some View {
        HStack(spacing: 10) {
            TodayMetric(
                value: "\(model.briefing.schedule.count)",
                label: "Events",
                symbol: "calendar",
                color: .blue
            )

            TodayMetric(
                value: "\(model.briefing.priorities.count)",
                label: "Priorities",
                symbol: "flag.fill",
                color: .orange
            )

            TodayMetric(
                value: "\(model.briefing.attentionCount)",
                label: "Decisions",
                symbol: "sparkles",
                color: .purple
            )
        }
    }

    private var scheduleSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "Schedule", detail: "\(model.briefing.schedule.count) events")

            SurfaceCard {
                VStack(spacing: 0) {
                    ForEach(Array(model.briefing.schedule.enumerated()), id: \.element.id) { index, item in
                        HStack(alignment: .top, spacing: 12) {
                            Text(item.time)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .frame(width: 62, alignment: .leading)
                                .padding(.top, 8)

                            VStack(spacing: 0) {
                                Image(systemName: item.symbol)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Color.accentColor)
                                    .frame(width: 34, height: 34)
                                    .background(Color.accentColor.opacity(0.11), in: Circle())

                                if index < model.briefing.schedule.count - 1 {
                                    Rectangle()
                                        .fill(Color.secondary.opacity(0.18))
                                        .frame(width: 2, height: 30)
                                }
                            }
                            .accessibilityHidden(true)

                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title)
                                    .font(.body.weight(.semibold))
                                Text(item.detail)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.top, 6)

                            Spacer(minLength: 0)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(item.time), \(item.title), \(item.detail)")
                    }
                }
            }
        }
    }

    private var prioritiesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "Priorities", detail: "See all") {
                model.selectedTab = .tasks
            }

            VStack(spacing: 10) {
                ForEach(model.briefing.priorities) { task in
                    NavigationLink {
                        TaskDetailView(task: task, detail: model.detail(for: task))
                    } label: {
                        SurfaceCard {
                            HStack(spacing: 12) {
                                TaskRow(task: task)
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens task details")
                }
            }
        }
    }

    private func sectionHeader(
        title: String,
        detail: String,
        action: (() -> Void)? = nil
    ) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.title2.bold())
            Spacer()

            if let action {
                Button(detail, action: action)
                    .font(.subheadline.weight(.semibold))
            } else {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct TodayMetric: View {
    let value: String
    let label: String
    let symbol: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Image(systemName: symbol)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(color)
                Spacer()
                Text(value)
                    .font(.title2.bold())
            }

            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(.quaternary, lineWidth: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(value) \(label)")
    }
}

#Preview {
    TodayView(model: .preview)
}
