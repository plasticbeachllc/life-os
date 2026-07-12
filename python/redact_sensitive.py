import json
import sys

from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig


def main() -> None:
    request = json.load(sys.stdin)
    texts = request.get("texts")
    if not isinstance(texts, list) or any(not isinstance(text, str) for text in texts):
        raise ValueError("texts must be an array of strings")

    provider = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy",
        "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
    })
    nlp_engine = provider.create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp_engine)
    entities = [
        "CREDIT_CARD", "CRYPTO", "IBAN_CODE", "IP_ADDRESS",
        "MEDICAL_LICENSE", "US_BANK_NUMBER", "US_DRIVER_LICENSE",
        "US_ITIN", "US_PASSPORT", "US_SSN",
    ]
    anonymizer = AnonymizerEngine()
    results = []
    for text in texts:
        findings = analyzer.analyze(text=text, language="en", entities=entities, score_threshold=0.5)
        anonymized = anonymizer.anonymize(
            text=text,
            analyzer_results=findings,
            operators={"DEFAULT": OperatorConfig("replace")},
        )
        results.append({
            "text": anonymized.text,
            "findings": [
                {"entityType": finding.entity_type, "score": round(finding.score, 3)}
                for finding in findings
            ],
        })
    print(json.dumps({"results": results}))


if __name__ == "__main__":
    main()
