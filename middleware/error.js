export function notFound(req, res, next) {
  const err = new Error(`Not Found - ${req.originalUrl}`);
  err.status = 404;
  next(err);
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  res.status(status).json({
    message: err.message || "Server error",
    stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
  });
}
