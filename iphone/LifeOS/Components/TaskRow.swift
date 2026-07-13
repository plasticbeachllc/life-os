import SwiftUI

struct TaskRow: View {
    let task: LifeTask

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: task.isComplete ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(task.isComplete ? Color.green : priorityColor)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                Text(task.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(task.isComplete ? .secondary : .primary)
                    .strikethrough(task.isComplete)

                HStack(spacing: 8) {
                    Text(task.project)

                    if let dueLabel = task.dueLabel {
                        Text("•")
                        Text(dueLabel)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var priorityColor: Color {
        switch task.priority {
        case .high: .orange
        case .normal: .accentColor
        case .low: .secondary
        }
    }

    private var accessibilityLabel: String {
        let completion = task.isComplete ? "Completed" : "Open"
        let due = task.dueLabel.map { ", due \($0)" } ?? ""
        return "\(completion), \(task.title), \(task.project)\(due)"
    }
}
