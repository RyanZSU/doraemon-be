import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiErrorResponse } from '../types/api-response.js';
import { getRequestId } from '../middleware/request-id.middleware.js';

interface HttpExceptionBody {
  message?: string | string[];
  error?: string;
}

/** Turns every thrown error into the same response envelope the client expects. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter<unknown> {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (response.headersSent) {
      return;
    }

    const { status, message, details } = this.normalize(exception);

    const logMessage = `${request.method} ${request.originalUrl} -> ${status}: ${message}`;
    if (status >= 500) {
      this.logger.error(
        logMessage,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(logMessage);
    }

    const body: ApiErrorResponse = {
      code: status,
      message,
      data: null,
      requestId: getRequestId(request),
      timestamp: new Date().toISOString(),
      ...(details ? { details } : {}),
    };

    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    message: string;
    details?: string[];
  } {
    if (!(exception instanceof HttpException)) {
      return { status: 500, message: 'Internal server error' };
    }

    const status = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return { status, message: payload };
    }

    const body = payload as HttpExceptionBody;
    if (Array.isArray(body.message)) {
      return {
        status,
        message: body.message.join('; '),
        details: body.message,
      };
    }

    return {
      status,
      message: body.message ?? body.error ?? exception.message,
    };
  }
}