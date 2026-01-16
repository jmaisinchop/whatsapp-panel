// src/auth/jwt.strategy.ts

import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { ConfigService } from '@nestjs/config'; // <-- 1. IMPORTAR

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  // 2. INYECTAR ConfigService en el constructor
  constructor(private configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // 3. LEER el secreto desde ConfigService
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    // El objeto que retornamos aquí se inyectará en req.user
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
    };
  }
}