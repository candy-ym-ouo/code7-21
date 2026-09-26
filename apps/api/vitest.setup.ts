// Test environment for the API package. Values are only defaults so a real
// environment can still override them when running against live services.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://map:map@localhost:5432/map_test";
process.env.REDIS_URL ??= "redis://localhost:6379/1";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_PUBLIC_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY ??= "test-access-key";
process.env.S3_SECRET_KEY ??= "test-secret-key";
process.env.S3_QUARANTINE_BUCKET ??= "quarantine-test";
process.env.S3_PUBLIC_BUCKET ??= "public-test";
process.env.PUBLIC_MEDIA_BASE_URL ??= "https://media.example.test";
process.env.JWT_ACCESS_SECRET ??= "vitest-access-secret-with-32+-chars";
