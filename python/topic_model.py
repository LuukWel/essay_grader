"""
BGE + Gemma topic modelling for one essay set.

Exact port of the research "hybrid" method (run_cd.py + methods/hybrid.py):
  1. BAAI/bge-large-en-v1.5 sentence embeddings on minimally cleaned text
  2. sklearn KMeans(n_clusters=k, random_state=42, n_init=10)
  3. c-TF-IDF top words per cluster (preprocessed tokens)
  4. gemma2:9b (via Ollama) writes a 3-6 word label per cluster from the
     top words + 3 representative excerpts (temperature 0, seed 42)

Run by src/server/integrations/topic-python.ts. Stateless: reads a JSON job from stdin,
writes a JSON result to stdout.
All progress output goes to stderr. Caching is done by the Next.js caller.

stdin:
  {"essay_set": "C", "k": 5, "essays": [{"id": "1674", "text": "..."}, ...]}
stdout:
  {"topics": [{"label": "...", "keywords": ["..."]}, ...],
   "assignments": {"1674": 0, ...},
   "meta": {...}}

Requires: pip install sentence-transformers scikit-learn
Optional: spacy + en_core_web_sm (lemmatised keywords, as in the research setup)
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

EXCERPT_WORDS = 60  # words shown per representative essay in the label prompt

DOMAIN_STOPWORDS = {
    "would", "could", "think", "also", "one", "like", "make", "get", "use",
    "people", "many", "first", "much", "well", "even", "say", "said", "want",
    "need", "thing", "things", "way", "good", "time", "life", "know",
}

_LABEL_PROMPT = """\
You are labeling a group of student essays that share the same theme.

Key words found in this group: {keywords}

Sample essay excerpts from this group:
{excerpts}

Write a short, descriptive topic label (3-6 words) that captures what these essays are about.
Reply with ONLY the label — no explanation.

Label:"""


def log(msg: str) -> None:
    print(f"[bge-gemma] {msg}", file=sys.stderr, flush=True)


# Input. Reads the subset CSV when possible so the row order, and therefore the
# clusters, match the research run.

def canonical_essays(essay_set: str, essays: list[dict]) -> list[tuple[str, str]]:
    given = {str(e["id"]): e["text"] for e in essays}
    path = DATA_DIR / f"subset_{essay_set}.csv"
    if not path.exists():
        return list(given.items())

    with open(path, encoding="utf-8") as f:
        rows = [(row["id"], row["essay"]) for row in csv.DictReader(f)]
    ordered = [(i, t) for i, t in rows if i in given]
    missing = set(given) - {i for i, _ in ordered}
    if missing:
        log(f"{len(missing)} essay(s) not in {path.name}; using text supplied by the app for those")
        ordered += [(i, given[i]) for i in given if i in missing]
    log(f"using text + order from {path.name}")
    return ordered


# Preprocessing (preprocess.py)

def clean_minimal(texts: list[str]) -> list[str]:
    return [re.sub(r"\s+", " ", t).strip() for t in texts]


def clean_for_classical(texts: list[str]) -> tuple[list[list[str]], str]:
    """Tokens for c-TF-IDF keywords, plus which preprocessing produced them.

    spaCy lemmatisation is used when en_core_web_sm is installed (research setup);
    otherwise scikit-learn stopwords. The two give different keywords, so the caller
    reports the mode instead of switching silently.
    """
    try:
        import spacy
        nlp = spacy.load("en_core_web_sm", disable=["parser", "ner"])
    except Exception:
        nlp = None

    if nlp is not None:
        result = []
        for doc in nlp.pipe(texts, batch_size=32):
            result.append([
                token.lemma_.lower()
                for token in doc
                if not token.is_stop
                and not token.is_punct
                and not token.is_space
                and len(token.lemma_) > 2
                and token.lemma_.isalpha()
                and token.lemma_.lower() not in DOMAIN_STOPWORDS
            ])
        return result, "spacy-lemma"

    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS
    stop = set(ENGLISH_STOP_WORDS) | DOMAIN_STOPWORDS
    result = []
    for text in texts:
        text = re.sub(r"[^a-z\s]", " ", text.lower())
        result.append([w for w in text.split() if len(w) > 2 and w not in stop])
    return result, "sklearn-stopwords"


def truncate_words(text: str, max_words: int) -> str:
    return " ".join(text.split()[:max_words])


# c-TF-IDF (evaluate.extract_top_words_ctfidf)

def extract_top_words_ctfidf(tokenized: list[list[str]], labels: list[int], n_words: int = 10) -> list[list[str]]:
    unique_labels = sorted(set(labels))
    cluster_docs = []
    for lbl in unique_labels:
        tokens = [t for i, l in enumerate(labels) if l == lbl for t in tokenized[i]]
        cluster_docs.append(" ".join(tokens) if tokens else "unknown")

    if len(cluster_docs) < 2:
        all_tokens = [t for doc in tokenized for t in doc]
        return [[w for w, _ in Counter(all_tokens).most_common(n_words)]]

    from sklearn.feature_extraction.text import TfidfVectorizer
    vec = TfidfVectorizer(max_features=10_000)
    tfidf = vec.fit_transform(cluster_docs)
    feature_names = vec.get_feature_names_out()

    topics = []
    for i in range(len(unique_labels)):
        row = tfidf[i].toarray()[0]
        top_idx = row.argsort()[-n_words:][::-1]
        topics.append([str(feature_names[j]) for j in top_idx])
    return topics


# Gemma labelling (hybrid._label_cluster). Errors are fatal so a keyword-only
# fallback label is never cached.

def ollama_chat(base_url: str, model: str, prompt: str) -> str:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0.0, "seed": 42},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Ollama explains the failure in the body (e.g. not enough memory to load the model).
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"Ollama returned HTTP {e.code} for {model}: {detail}") from None
    return data["message"]["content"].strip()


def label_cluster(cluster_texts: list[str], top_words: list[str], model: str, base_url: str) -> str:
    excerpts = "\n---\n".join(truncate_words(t, EXCERPT_WORDS) for t in cluster_texts[:3])
    prompt = _LABEL_PROMPT.format(keywords=", ".join(top_words[:10]), excerpts=excerpts)
    label = ollama_chat(base_url, model, prompt)
    label = re.sub(r"[\"'*\n]", "", label).strip()
    if not label:
        raise RuntimeError("empty label from LLM")
    return label


# Embedding and clustering

def embed_texts(texts: list[str], model_name: str):
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer(model_name).encode(texts, show_progress_bar=False, batch_size=32)


def cluster(embeddings, k: int, seed: int) -> list[int]:
    from sklearn.cluster import KMeans
    return KMeans(n_clusters=k, random_state=seed, n_init=10).fit_predict(embeddings).tolist()


# Topic labelling: one label per cluster, in cluster order

def label_topics(texts: list[str], labels: list[int], topic_words: list[list[str]], model: str, base_url: str) -> list[dict]:
    topics = []
    for i, lbl in enumerate(sorted(set(labels))):
        cluster_texts = [texts[j] for j, l in enumerate(labels) if l == lbl]
        words = topic_words[i] if i < len(topic_words) else []
        label = label_cluster(cluster_texts, words, model, base_url)
        log(f"  cluster {lbl} ({len(cluster_texts)} essays): {label!r}")
        topics.append({"label": label, "keywords": words})
    return topics


# Input and output

def read_job(stream) -> tuple[str, int, list[tuple[str, str]]]:
    """The job from stdin: essay set, k, and (id, text) pairs in research order."""
    job = json.loads(stream.read().decode("utf-8"))
    essay_set = str(job["essay_set"])
    k = int(job["k"])
    pairs = canonical_essays(essay_set, job["essays"])
    if k < 2 or k > len(pairs):
        raise ValueError(f"k={k} is invalid for {len(pairs)} essays")
    return essay_set, k, pairs


def build_result(ids: list[str], labels: list[int], topics: list[dict], meta: dict) -> dict:
    """Topics in cluster order; assignments map each essay ID to its topic's position."""
    index_of = {lbl: i for i, lbl in enumerate(sorted(set(labels)))}
    return {
        "topics": topics,
        "assignments": {essay_id: index_of[l] for essay_id, l in zip(ids, labels)},
        "meta": meta,
    }


# Main

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--embed-model", default="BAAI/bge-large-en-v1.5")
    parser.add_argument("--llm-model", default="gemma2:9b")
    parser.add_argument("--ollama-url", default=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    essay_set, k, pairs = read_job(sys.stdin.buffer)
    ids = [i for i, _ in pairs]
    texts = [t for _, t in pairs]

    t0 = time.time()
    minimal = clean_minimal(texts)
    tokenized, preprocessing = clean_for_classical(texts)
    log(f"keyword preprocessing: {preprocessing}")

    log(f"set {essay_set}: encoding {len(ids)} essays with {args.embed_model} ...")
    embeddings = embed_texts(minimal, args.embed_model)

    log(f"KMeans k={k} seed={args.seed} ...")
    labels = cluster(embeddings, k, args.seed)
    topic_words = extract_top_words_ctfidf(tokenized, labels)

    log(f"labelling {len(set(labels))} clusters with {args.llm_model} ...")
    topics = label_topics(minimal, labels, topic_words, args.llm_model, args.ollama_url)

    result = build_result(ids, labels, topics, {
        "embed_model": args.embed_model,
        "llm_model": args.llm_model,
        "k": k,
        "seed": args.seed,
        "preprocessing": preprocessing,
        "runtime_s": round(time.time() - t0, 1),
    })
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
    log(f"done in {result['meta']['runtime_s']}s")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FAILED: {type(e).__name__}: {e}")
        sys.exit(1)
