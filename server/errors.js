// Shared error type for the service, routes and bot API (HTTP status + machine-readable code).
export class AppError extends Error { constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; } }
