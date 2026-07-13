import SwiftUI

struct TasksView: View {
    @Bindable var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(model.filteredTasks) { task in
                        NavigationLink {
                            TaskDetailView(task: task, detail: model.detail(for: task))
                        } label: {
                            TaskRow(task: task)
                                .padding(.vertical, 4)
                        }
                    }
                } footer: {
                    Text("Tasks are mock, read-only projections in this prototype.")
                }
            }
            .navigationTitle("Tasks")
            .searchable(text: $model.taskSearch, prompt: "Search tasks or projects")
            .overlay {
                if model.filteredTasks.isEmpty {
                    ContentUnavailableView.search(text: model.taskSearch)
                }
            }
        }
    }
}

#Preview {
    TasksView(model: .preview)
}
