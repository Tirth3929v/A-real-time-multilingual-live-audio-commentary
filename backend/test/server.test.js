const request = require('supertest');
const { app, server } = require('../server');

describe('Server Health and HTTP API', () => {
  it('should return 200 OK from the root endpoint', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('Node.js Orchestration Layer is Live');
  });

  it('should validate payloads in /internal/stream-update', async () => {
    const res = await request(app)
      .post('/internal/stream-update')
      .send({ invalid_payload: true });
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('should reject payloads with XSS vectors in /internal/stream-update', async () => {
    const res = await request(app)
      .post('/internal/stream-update')
      .send({ 
        languageRoom: 'en',
        originalText: '<script>alert(1)</script>'
      });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('illegal anomalous symbols');
  });
});
