import { IsEmail, IsString, MinLength, IsEnum, IsOptional } from 'class-validator';

export class UpdateUserDto {
  @IsEmail({}, { message: 'El campo email debe ser un correo electrónico válido.' })
  @IsOptional()
  email?: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })
  @IsOptional()
  password?: string;

  @IsEnum(['admin', 'agent'], { message: 'El rol debe ser "admin" o "agent".' })
  @IsOptional()
  role?: string;

  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;
}