// dashboard.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { SurveyResponse, SurveyRating } from '../chat/entities/survey-response.entity';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private readonly CACHE_KEY = 'dashboard:survey-analytics';
  private readonly CACHE_TTL = 300;

  constructor(
    @InjectRepository(SurveyResponse)
    private readonly surveyResponseRepo: Repository<SurveyResponse>,

    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) { }

  async getSurveyAnalytics() {
    try {
      const cached = await this.cacheManager.get(this.CACHE_KEY);
      if (cached) {
        this.logger.debug('[CACHE] Dashboard servido desde caché');
        return cached;
      }

      this.logger.debug('[CACHE] Calculando dashboard analytics desde DB...');

      const analytics = await this.calculateAnalytics();

      await this.cacheManager.set(this.CACHE_KEY, analytics, this.CACHE_TTL);
      this.logger.debug(`[CACHE] Dashboard guardado en caché (${this.CACHE_TTL}s)`);

      return analytics;

    } catch (error) {
      this.logger.error('[ERROR] Error obteniendo analytics:', error.stack);

      return {
        counts: {
          [SurveyRating.EXCELENTE]: 0,
          [SurveyRating.REGULAR]: 0,
          [SurveyRating.MALA]: 0,
        },
        comments: [],
      };
    }
  }

  private async calculateAnalytics() {
    const counts = await this.surveyResponseRepo
      .createQueryBuilder('survey')
      .select('survey.rating', 'rating')
      .addSelect('COUNT(survey.id)', 'count')
      .groupBy('survey.rating')
      .getRawMany();

    const surveyCounts = {
      [SurveyRating.EXCELENTE]: 0,
      [SurveyRating.REGULAR]: 0,
      [SurveyRating.MALA]: 0,
    };

    counts.forEach(item => {
      surveyCounts[item.rating] = Number.parseInt(item.count, 10);
    });

    const recentComments = await this.surveyResponseRepo
      .createQueryBuilder('survey')
      .leftJoinAndSelect('survey.chat', 'chat')
      .where('survey.comment IS NOT NULL')
      .andWhere('survey.comment != :empty', { empty: '' })
      .orderBy('survey.createdAt', 'DESC')
      .limit(10)
      .getMany();

    const filteredComments = recentComments
      .filter(comment => comment.comment && comment.comment.trim().length > 5)
      .slice(0, 5);

    return {
      counts: surveyCounts,
      comments: filteredComments,
    };
  }

  async invalidateSurveyCache(): Promise<void> {
    try {
      const deleted = await this.cacheManager.del(this.CACHE_KEY);

      if (deleted) {
        this.logger.log('[CACHE] Caché de dashboard invalidado correctamente');
      } else {
        this.logger.debug('[CACHE] No había caché para invalidar');
      }
    } catch (error) {
      this.logger.error('[CACHE] Error invalidando caché de dashboard:', error);
    }
  }

  async getRealtimeStats() {
    try {
      const [total, excellentCount, regularCount, badCount] = await Promise.all([
        this.surveyResponseRepo.count(),
        this.surveyResponseRepo.count({ where: { rating: SurveyRating.EXCELENTE } }),
        this.surveyResponseRepo.count({ where: { rating: SurveyRating.REGULAR } }),
        this.surveyResponseRepo.count({ where: { rating: SurveyRating.MALA } }),
      ]);

      const calculatePercentage = (count: number) =>
        total > 0 ? Math.round((count / total) * 100) : 0;

      return {
        total,
        counts: {
          [SurveyRating.EXCELENTE]: excellentCount,
          [SurveyRating.REGULAR]: regularCount,
          [SurveyRating.MALA]: badCount,
        },
        percentages: {
          [SurveyRating.EXCELENTE]: calculatePercentage(excellentCount),
          [SurveyRating.REGULAR]: calculatePercentage(regularCount),
          [SurveyRating.MALA]: calculatePercentage(badCount),
        },
        averageRating: this.calculateAverageRating(excellentCount, regularCount, badCount),
      };
    } catch (error) {
      this.logger.error('[ERROR] Error obteniendo stats en tiempo real:', error.stack);
      throw error;
    }
  }

  private calculateAverageRating(excellent: number, regular: number, bad: number): number {
    const total = excellent + regular + bad;
    if (total === 0) return 0;

    const weightedSum = (excellent * 3) + (regular * 2) + (bad * 1);
    return Math.round((weightedSum / total) * 100) / 100;
  }

  async getSurveyTrend(days: number = 7) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      startDate.setHours(0, 0, 0, 0);

      const surveys = await this.surveyResponseRepo
        .createQueryBuilder('survey')
        .select("TO_CHAR(survey.createdAt AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD')", 'date')
        .addSelect('survey.rating', 'rating')
        .addSelect('COUNT(*)', 'count')
        .where('survey.createdAt >= :startDate', { startDate })
        .groupBy("TO_CHAR(survey.createdAt AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD')")
        .addGroupBy('survey.rating')
        .orderBy('date', 'ASC')
        .getRawMany();

      const trendData = this.formatTrendData(surveys, days);

      return {
        period: `${days} días`,
        data: trendData,
      };
    } catch (error) {
      this.logger.error('[ERROR] Error obteniendo tendencia:', error.stack);
      throw error;
    }
  }

  private formatTrendData(surveys: any[], days: number) {
    const result = [];
    const today = new Date();

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      const dayData = {
        date: dateStr,
        [SurveyRating.EXCELENTE]: 0,
        [SurveyRating.REGULAR]: 0,
        [SurveyRating.MALA]: 0,
        total: 0,
      };

      surveys.forEach(survey => {
        if (survey.date === dateStr) {
          dayData[survey.rating] = Number.parseInt(survey.count, 10);
          dayData.total += Number.parseInt(survey.count, 10);
        }
      });

      result.push(dayData);
    }

    return result;
  }

  async getCommentsByRating(rating: SurveyRating, limit: number = 10) {
    try {
      return await this.surveyResponseRepo.find({
        where: {
          rating,
          comment: Not(IsNull()),
        },
        order: { createdAt: 'DESC' },
        take: limit,
        relations: ['chat'],
      });
    } catch (error) {
      this.logger.error(`[ERROR] Error obteniendo comentarios ${rating}:`, error.stack);
      throw error;
    }
  }

  async clearAllCache(): Promise<void> {
    try {
      const keysToDelete = [
        this.CACHE_KEY,
        'dashboard:realtime-stats',
        'dashboard:trend',
      ];

      await Promise.all(
        keysToDelete.map(key => this.cacheManager.del(key))
      );

      this.logger.log('[CACHE] Caché del dashboard limpiado correctamente');
    } catch (error) {
      this.logger.error('[ERROR] Error limpiando caché:', error);
      throw error;
    }
  }
}