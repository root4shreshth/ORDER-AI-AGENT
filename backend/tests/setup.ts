// Test environment. Integration tests use a SEPARATE database and queue name so they never
// touch dev data or get picked up by a running dev worker.
process.env.NODE_ENV = "test";
process.env.LLM_MODE = "mock";
process.env.ORDER_WEBHOOK_SECRET = "test-order-secret";
process.env.COURIER_WEBHOOK_SECRET = "test-courier-secret";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://wishluck:wishluck@localhost:5455/wishluck_test";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6385/1";
process.env.QUEUE_NAME = "wishluck-jobs-test";
process.env.PUBLIC_API_URL = "http://127.0.0.1:4555";
process.env.ANTHROPIC_API_KEY = "";
