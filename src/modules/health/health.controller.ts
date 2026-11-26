import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../../common/decorators/public.decorator.js';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
  ) {}

  /** Readiness probe used by App Service's health check (HTTP 200/503). */
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: '健康检查（含数据库连通性）' })
  check() {
    return this.health.check([
      () => this.mongoose.pingCheck('mongodb', { timeout: 3000 }),
    ]);
  }

  /** Lightweight liveness probe that does not touch the database. */
  @Get('live')
  @ApiOperation({ summary: '存活检查（不访问数据库）' })
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}