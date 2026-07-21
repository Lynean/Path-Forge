from src.calculator import add


def test_adds_two_integers() -> None:
    assert add(20, 22) == 42

