// src/dashboard/dashboard.controller.ts - VERSIÓN CORREGIDA COMPLETA
// =====================================================
// CORRECCIONES APLICADAS:
// ✅ 1. Nuevos endpoints para stats en tiempo real
// ✅ 2. Endpoint para tendencias
// ✅ 3. Endpoint para comentarios por rating
// ✅ 4. Endpoint admin para limpiar caché
// ✅ 5. Validación de parámetros
// =====================================================

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
@UseGuards(AuthGuard('jwt')) // Todos los endpoints requieren autenticación
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * ✅ ENDPOINT PRINCIPAL: Analytics con caché
   * GET /dashboard/survey-analytics
   * 
   * Devuelve estadísticas agregadas de encuestas con caché de 5 minutos
   */
  @Get('survey-analytics')
  getSurveyAnalytics() {
    return this.dashboardService.getSurveyAnalytics();
  }

  /**
   * ✅ NUEVO: Stats en tiempo real (sin caché)
   * GET /dashboard/realtime-stats
   * 
   * Para cuando necesitas datos 100% frescos
   */
  @Get('realtime-stats')
  getRealtimeStats() {
    return this.dashboardService.getRealtimeStats();
  }

  /**
   * ✅ NUEVO: Tendencia de encuestas
   * GET /dashboard/survey-trend?days=7
   * 
   * Devuelve datos diarios de los últimos N días
   */
  @Get('survey-trend')
  async getSurveyTrend(
    @Query('days', new ParseIntPipe({ optional: true })) days?: number
  ) {
    // Validar rango de días
    const validDays = days || 7;
    if (validDays < 1 || validDays > 90) {
      throw new BadRequestException('El parámetro "days" debe estar entre 1 y 90');
    }

    return this.dashboardService.getSurveyTrend(validDays);
  }

  /**
   * ✅ NUEVO: Comentarios por rating
   * GET /dashboard/comments/EXCELENTE?limit=10
   * 
   * Obtiene comentarios filtrados por calificación
   */
  @Get('comments/:rating')
  async getCommentsByRating(
    @Param('rating', new ParseEnumPipe(SurveyRating)) rating: SurveyRating,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    const validLimit = limit || 10;
    if (validLimit < 1 || validLimit > 100) {
      throw new BadRequestException('El parámetro "limit" debe estar entre 1 y 100');
    }

    return this.dashboardService.getCommentsByRating(rating, validLimit);
  }

  /**
   * ✅ NUEVO: Invalidar caché manualmente
   * POST /dashboard/cache/invalidate
   * 
   * Solo para administradores
   */
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

  /**
   * ✅ NUEVO: Limpiar todo el caché del dashboard
   * POST /dashboard/cache/clear
   * 
   * Solo para administradores - Útil en troubleshooting
   */
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