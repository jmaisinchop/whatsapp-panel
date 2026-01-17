// dashboard.controller.ts
import { 
  Controller, 
  Get, 
  Post,
  Query,
  Param,
  UseGuards,
  ParseIntPipe,
  ParseEnumPipe,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/guards/roles.decorator';
import { DashboardService } from './dashboard.service';
import { SurveyRating } from '../chat/entities/survey-response.entity';

@Controller('dashboard')
@UseGuards(AuthGuard('jwt'))
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('survey-analytics')
  getSurveyAnalytics() {
    return this.dashboardService.getSurveyAnalytics();
  }

  @Get('realtime-stats')
  getRealtimeStats() {
    return this.dashboardService.getRealtimeStats();
  }

  @Get('survey-trend')
  async getSurveyTrend(
    @Query('days', new ParseIntPipe({ optional: true })) days: number = 7
  ) {
    if (days < 1 || days > 90) {
      throw new BadRequestException('El parámetro "days" debe estar entre 1 y 90');
    }

    return this.dashboardService.getSurveyTrend(days);
  }

  @Get('comments/:rating')
  async getCommentsByRating(
    @Param('rating', new ParseEnumPipe(SurveyRating)) rating: SurveyRating,
    @Query('limit', new ParseIntPipe({ optional: true })) limit: number = 10
  ) {
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('El parámetro "limit" debe estar entre 1 y 100');
    }

    return this.dashboardService.getCommentsByRating(rating, limit);
  }

  @Post('cache/invalidate')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async invalidateCache() {
    await this.dashboardService.invalidateSurveyCache();
    return { 
      message: 'Caché invalidado correctamente',
      timestamp: new Date().toISOString(),
    };
  }

  @Post('cache/clear')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async clearCache() {
    await this.dashboardService.clearAllCache();
    return { 
      message: 'Caché del dashboard limpiado correctamente',
      timestamp: new Date().toISOString(),
    };
  }
}