// Shared Winston logger for API routes + worker. (Guide §4: winston)
import winston from "winston";

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === "production"
      ? winston.format.json()
      : winston.format.simple(),
  ),
  transports: [new winston.transports.Console()],
});
