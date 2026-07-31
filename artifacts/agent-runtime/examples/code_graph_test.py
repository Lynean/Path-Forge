"""Sample program for testing the indentation code-graph viewer."""

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_GOAL = 3
OUTPUT_FILE = Path("habit-summary.txt")


@dataclass
class Habit:
    name: str
    completed_days: int = 0
    goal: int = DEFAULT_GOAL

    @property
    def is_complete(self) -> bool:
        return self.completed_days >= self.goal

    def record_day(self) -> None:
        if self.is_complete:
            print(f"{self.name} is already complete.")
        else:
            self.completed_days += 1
            if self.is_complete:
                print(f"Goal reached for {self.name}!")
            else:
                remaining = self.goal - self.completed_days
                print(f"{self.name}: {remaining} day(s) remaining.")


def completed_habits(habits: Iterable[Habit]) -> list[Habit]:
    return [habit for habit in habits if habit.is_complete]


def build_summary(habits: list[Habit]) -> str:
    lines = ["Habit summary", "============="]

    for index, habit in enumerate(habits, start=1):
        status = "complete" if habit.is_complete else "in progress"
        lines.append(
            f"{index}. {habit.name}: "
            f"{habit.completed_days}/{habit.goal} ({status})"
        )

    completed = completed_habits(habits)
    lines.append("")
    lines.append(f"Completed: {len(completed)}/{len(habits)}")
    return "\n".join(lines)


def save_summary(summary: str, output_path: Path = OUTPUT_FILE) -> None:
    try:
        output_path.write_text(summary + "\n", encoding="utf-8")
    except OSError as error:
        print(f"Could not save the summary: {error}")
    else:
        print(f"Saved summary to {output_path.resolve()}")


def main() -> None:
    habits = [
        Habit("Read", completed_days=2),
        Habit("Exercise", completed_days=1, goal=2),
        Habit("Meditate", completed_days=3),
    ]

    def find_habit(name: str) -> Habit | None:
        for habit in habits:
            if habit.name.lower() == name.lower():
                return habit
        return None

    selected = find_habit("Read")
    if selected is not None:
        selected.record_day()

    for habit in habits:
        if not habit.is_complete:
            habit.record_day()

    summary = build_summary(habits)
    print()
    print(summary)
    save_summary(summary)


if __name__ == "__main__":
    main()
