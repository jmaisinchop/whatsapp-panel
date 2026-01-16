import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
export class UpdateStatusDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(25) // Límite de caracteres para la Info de WhatsApp
  status: string;
}