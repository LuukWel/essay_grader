"""Tests for the parts of topic_model.py that need no ML packages (input, output, cleaning).

Run from the project folder:  python -m unittest discover -s python
"""

import io
import json
import unittest

import topic_model as tm


class ReadJobTest(unittest.TestCase):
    def job(self, k, essays):
        return io.BytesIO(json.dumps({"essay_set": "NO_SUCH_SET", "k": k, "essays": essays}).encode("utf-8"))

    def test_reads_set_k_and_essays(self):
        essays = [{"id": "A", "text": "one"}, {"id": "B", "text": "two"}]
        self.assertEqual(tm.read_job(self.job(2, essays)), ("NO_SUCH_SET", 2, [("A", "one"), ("B", "two")]))

    def test_rejects_k_outside_2_to_number_of_essays(self):
        essays = [{"id": "A", "text": "one"}, {"id": "B", "text": "two"}]
        for k in (1, 3):
            with self.assertRaises(ValueError):
                tm.read_job(self.job(k, essays))


class BuildResultTest(unittest.TestCase):
    def test_topics_follow_cluster_order_and_every_essay_is_assigned(self):
        # KMeans cluster numbers need not start at 0 or be contiguous in the output.
        result = tm.build_result(["A", "B", "C"], [3, 1, 3], [{"label": "x"}, {"label": "y"}], {"k": 2})
        self.assertEqual(result["assignments"], {"A": 1, "B": 0, "C": 1})
        self.assertEqual(result["meta"], {"k": 2})


class CleaningTest(unittest.TestCase):
    def test_clean_minimal_collapses_whitespace(self):
        self.assertEqual(tm.clean_minimal(["  two\n\nlines\t here "]), ["two lines here"])

    def test_truncate_words(self):
        self.assertEqual(tm.truncate_words("a b c d", 2), "a b")


if __name__ == "__main__":
    unittest.main()
