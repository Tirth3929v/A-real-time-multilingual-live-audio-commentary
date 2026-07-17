from fastapi.testclient import TestClient
from src.main import app

client = TestClient(app)

def test_health_endpoint_returns_success():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"status": "AI Service is active and functional!"}

def test_audio_endpoint_rejects_malformed_payload():
    # Sending invalid data types that violate Pydantic Field constraints
    response = client.post("/audio", json={
        "audio": "base64data",
        "sourceLanguage": "this-language-code-is-way-too-long-for-the-max-length-constraint",
        "targetLanguage": "hi"
    })
    assert response.status_code == 422
    assert "detail" in response.json()

def test_audio_endpoint_rejects_missing_required_fields():
    response = client.post("/audio", json={
        "sourceLanguage": "en"
    })
    assert response.status_code == 422
