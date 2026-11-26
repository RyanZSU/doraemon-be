import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './common/decorators/public.decorator.js';

@ApiTags('app')
@Controller()
export class AppController {
  @Public()
  @Get()
  @ApiOperation({ summary: '服务信息' })
  getServiceInfo(): { name: string; status: string; version: string } {
    return { name: 'doraemon-be', status: 'ok', version: '0.1.0' };
  }
}