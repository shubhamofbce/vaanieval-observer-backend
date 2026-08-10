from app.evaluation import (
    align,
    band,
    character_error_rate,
    disagreed_words,
    map_words_to_turns,
    normalize,
    percentiles,
    score_pair,
    tokenize,
    words_to_text,
)


def test_normalize_folds_case_punctuation_and_currency():
    assert normalize("Okay. Bengaluru!") == "okay bengaluru"
    assert "rupees" in normalize("₹2000")


def test_tokenize_folds_english_number_words_to_digits():
    assert tokenize("nine one") == ["9", "1"]
    assert tokenize("91") == ["91"]


def test_tokenize_leaves_devanagari_untouched():
    # The English number map is unsafe for Devanagari, so it must not run there.
    assert tokenize("नौ one") == ["नौ", "one"]


def test_score_pair_counts_each_operation():
    result = score_pair("I need some help with code", "I need help with the code")
    assert result["status"] == "evaluated"
    assert result["errors"] == result["substitutions"] + result["deletions"] + result["insertions"]
    assert result["challenger_word_count"] == 6
    assert result["estimated_wer"] == result["errors"] / 6


def test_score_pair_identical_text_is_zero():
    result = score_pair("Traveling from Patna.", "traveling from patna")
    assert result["estimated_wer"] == 0.0
    assert result["band"] == "low"


def test_score_pair_wer_is_not_clamped_at_one():
    result = score_pair("one two three four", "one")
    assert result["estimated_wer"] > 1.0


def test_score_pair_marks_missing_sides_without_inventing_a_rate():
    assert score_pair("", "")["status"] == "no_speech"
    assert score_pair("hello", "")["status"] == "challenger_empty"
    assert score_pair("hello", "")["estimated_wer"] is None
    missed = score_pair("", "hello there")
    assert missed["status"] == "possible_missed_speech"
    assert missed["deletions"] == 2 and missed["insertions"] == 0
    assert missed["estimated_wer"] == 1.0


def test_band_thresholds_match_the_documented_bands():
    assert band(0.05) == "low"
    assert band(0.10) == "moderate"
    assert band(0.25) == "moderate"
    assert band(0.26) == "high"
    assert band(None) == "unavailable"


def test_align_reports_indices_for_every_operation():
    entries = align(["a", "b", "c"], ["a", "x", "c", "d"])
    operations = [entry["operation"] for entry in entries]
    assert operations == ["match", "substitution", "match", "deletion"]
    assert entries[1]["production_word"] == "b" and entries[1]["challenger_word"] == "x"
    assert entries[3]["production_index"] is None


def test_character_error_rate_uses_the_challenger_as_denominator():
    assert character_error_rate("abc", "abc") == 0.0
    assert character_error_rate("abc", "") is None


def test_disagreed_words_groups_and_ranks_repeat_offenders():
    scores = [
        ("2", score_pair("raven street", "river street")),
        ("5", score_pair("raven road", "river road")),
    ]
    groups = disagreed_words(scores)
    assert groups[0]["production_word"] == "raven"
    assert groups[0]["challenger_word"] == "river"
    assert groups[0]["count"] == 2
    assert groups[0]["turns"] == ["2", "5"]


def test_map_words_to_turns_assigns_by_timestamp():
    words = [
        {"text": "hello", "start_ms": 1000, "end_ms": 1200, "type": "word"},
        {"text": "there", "start_ms": 5000, "end_ms": 5200, "type": "word"},
    ]
    windows = [
        {"turn_id": "1", "start_ms": 900, "end_ms": 1500},
        {"turn_id": "2", "start_ms": 4800, "end_ms": 5400},
    ]
    result = map_words_to_turns(words, windows)
    assert words_to_text(result["mapped"]["1"]) == "hello"
    assert words_to_text(result["mapped"]["2"]) == "there"
    assert result["summary"]["unmapped_word_count"] == 0


def test_map_words_to_turns_never_guesses_an_overlapping_word():
    words = [{"text": "maybe", "start_ms": 1000, "end_ms": 1100, "type": "word"}]
    windows = [
        {"turn_id": "1", "start_ms": 900, "end_ms": 1200},
        {"turn_id": "2", "start_ms": 1000, "end_ms": 1400},
    ]
    result = map_words_to_turns(words, windows)
    assert result["ambiguous_turn_ids"] == ["1", "2"]
    assert result["summary"]["unmapped_word_count"] == 1


def test_map_words_to_turns_ignores_non_word_tokens():
    words = [{"text": " ", "type": "spacing", "start_ms": 1000, "end_ms": 1010}]
    result = map_words_to_turns(words, [{"turn_id": "1", "start_ms": 0, "end_ms": 5000}])
    assert result["summary"]["word_count"] == 0


def test_percentiles_interpolate_between_ranks():
    result = percentiles([10, 20, 30, 40])
    assert result["count"] == 4
    assert result["min"] == 10 and result["max"] == 40
    assert result["p50"] == 25
    assert result["mean"] == 25


def test_percentiles_of_a_single_sample_is_that_sample():
    result = percentiles([7])
    assert result["p50"] == result["p95"] == result["max"] == 7


def test_percentiles_of_nothing_measured_is_explicitly_empty():
    result = percentiles([None, "x"])
    assert result == {"count": 0, "p50": None, "p90": None, "p95": None, "max": None, "min": None, "mean": None}


def test_insertions_and_deletions_follow_the_challenger_as_reference():
    # The challenger is the reference, so a challenger word production never
    # produced is a deletion, and a production-only word is an insertion.
    missed = score_pair("one two", "one two three")
    assert missed["deletions"] == 1 and missed["insertions"] == 0
    extra = score_pair("one two three", "one two")
    assert extra["insertions"] == 1 and extra["deletions"] == 0


def test_disagreement_evidence_shows_the_words_as_spoken():
    groups = disagreed_words([("1", score_pair("eight", "it"))])
    assert groups[0]["production_word"] == "eight"
    assert groups[0]["challenger_word"] == "it"


def test_devanagari_vowel_signs_survive_normalization():
    assert normalize("नौ") == "नौ"
