// Test defaults — unit tests never need real services; integration tests use the docker DB.
process.env.NODE_ENV = "test";
process.env.LLM_MODE ??= "mock";
process.env.ORDER_WEBHOOK_SECRET ??= "test-order-secret";
process.env.COURIER_WEBHOOK_SECRET ??= "test-courier-secret";
process.env.DATABASE_URL ??= "postgresql://wishluck:wishluck@localhost:5455/wishluck";
