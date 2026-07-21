from src.calculator import multiply


def test_multiplies_two_integers() -> None:
    assert multiply(6, 7) == 42

