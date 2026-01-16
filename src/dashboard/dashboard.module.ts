// src/dashboard/dashboard.module.ts - VERSIÓN CORREGIDA
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SurveyResponse } from '../chat/entities/survey-response.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SurveyResponse]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}