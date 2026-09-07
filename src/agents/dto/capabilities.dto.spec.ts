// class-validator's decorators need the metadata polyfill. The running app
// gets it from main.ts; a spec that imports the DTO directly does not.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CapabilitiesDto } from './capabilities.dto';

/**
 * The API validates with `forbidNonWhitelisted: true`, so any field the agent
 * sends that this DTO does not declare is a 400 rather than an ignored extra.
 * These cases pin the shape the agent actually reports.
 */
describe('CapabilitiesDto', () => {
  const realReport = {
    displays: [{ id: 'HDMI-A-0', width: 3840, height: 2160, x: 0, y: 0, primary: true }],
    audio_inputs: [
      { id: 'alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback', label: 'Jabra Link 390', channels: 1 },
    ],
    cameras: [],
    encoders: ['libx264', 'h264_vaapi'],
    session_type: 'x11',
    free_disk_bytes: 1810339102720,
    clock: { synchronised: true, offset_ms: 1, source: '6DE048AF' },
  };

  it('accepts the capability report this host actually produces', () => {
    const errors = validateSync(plainToInstance(CapabilitiesDto, realReport), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts display offsets, which multi-monitor capture depends on', () => {
    // x11grab captures at :0.0+X,Y. Rejecting these made a live agent fail
    // enrolment with "property x should not exist".
    const dto = plainToInstance(CapabilitiesDto, {
      ...realReport,
      displays: [{ id: 'DP-1', width: 1920, height: 1080, x: 3840, y: 0 }],
    });
    expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });

  it('accepts a negative offset for a monitor left of the origin', () => {
    const dto = plainToInstance(CapabilitiesDto, {
      ...realReport,
      displays: [{ id: 'DP-2', width: 1920, height: 1080, x: -1920, y: 0 }],
    });
    expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });

  it('accepts an empty camera list, which is this host normally', () => {
    const dto = plainToInstance(CapabilitiesDto, { ...realReport, cameras: [] });
    expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });
});
