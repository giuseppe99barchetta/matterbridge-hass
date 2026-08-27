/**
 * @file src/sensor.entity.ts
 * @description This file contains the addSensorEntity function.
 * @author Luca Liguori
 * @created 2025-08-25
 * @version 1.1.0
 * @license Apache-2.0
 *
 * Copyright 2025, 2026, 2027 Luca Liguori.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { airQualitySensor, electricalSensor, powerSource } from 'matterbridge';
import { CYAN, db, debugStringify } from 'matterbridge/logger';
import { AirQuality, ElectricalEnergyMeasurement } from 'matterbridge/matter/clusters';
import { getClusterNameById } from 'matterbridge/matter/types';
import { isValidString } from 'matterbridge/utils';

import { hassDomainSensorsConverter } from './converters.js';
import { getDomain } from './helpers.js';
import type { HassEntity, HassState } from './homeAssistant.js';
import type { HomeAssistantPlatform } from './module.js';
import type { MutableDevice } from './mutableDevice.js';

/**
 * Look for supported sensors of the current entity
 *
 * @param {HomeAssistantPlatform} platform - The Home Assistant platform instance
 * @param {MutableDevice} mutableDevice - The mutable device to which the sensor will be added
 * @param {HassEntity} entity - The Home Assistant entity to check
 * @param {HassState} state - The state of the Home Assistant entity
 * @param {RegExp | undefined} airQualityRegex - The regex to match air quality sensor entities
 * @param {boolean} battery - If the entity belongs to a battery powered device
 * @param {string | undefined} electricalMeasurementEndpoint - The outlet endpoint to which electrical measurements should be attached
 * @param {string | null | undefined} cumulativeEnergyEntityId - The only energy entity allowed to update cumulative imported energy; null disables energy import
 *
 * @returns {string | undefined} - The endpoint name for the sensor, if found; otherwise, undefined
 */
export function addSensorEntity(
  platform: HomeAssistantPlatform,
  mutableDevice: MutableDevice,
  entity: HassEntity,
  state: HassState,
  airQualityRegex: RegExp | undefined,
  battery: boolean,
  electricalMeasurementEndpoint?: string,
  cumulativeEnergyEntityId?: string | null,
): string | undefined {
  let endpointName: string | undefined = undefined;
  const domain = getDomain(entity.entity_id);
  if (domain !== 'sensor') return undefined;

  // Look for air_quality sensor entity using airqualityRegex
  if (airQualityRegex?.test(entity.entity_id)) {
    platform.log.debug(`+ air_quality entity ${CYAN}${entity.entity_id}${db} found for device ${CYAN}${mutableDevice.name()}${db}`);
    endpointName = 'AirQuality'; // Remap the endpoint name for the entity
    mutableDevice.addDeviceTypes('AirQuality', airQualitySensor); // Add the air quality sensor device type
    mutableDevice.addClusterServerIds('AirQuality', AirQuality.id); // Add the AirQuality cluster
    if (isValidString(state.attributes['friendly_name'])) mutableDevice.setFriendlyName('AirQuality', state.attributes['friendly_name']); // Set the friendly name for the air quality sensor
    return endpointName;
  }

  // Look for supported sensors of the current entity
  hassDomainSensorsConverter
    .filter((d) => d.domain === domain && d.withStateClass === state.attributes['state_class'] && d.withDeviceClass === state.attributes['device_class'])
    .forEach((hassDomainSensor) => {
      if (hassDomainSensor.clusterId === ElectricalEnergyMeasurement.id && cumulativeEnergyEntityId !== undefined && entity.entity_id !== cumulativeEnergyEntityId) return;
      // oxfmt-ignore
      if (hassDomainSensor.deviceType === powerSource && state.attributes['state_class'] === 'measurement' && state.attributes['device_class'] === 'voltage' && !battery) return; // Skip powerSource voltage sensor if the device is not battery powered
      // oxfmt-ignore
      if (hassDomainSensor.deviceType === electricalSensor && state.attributes['state_class'] === 'measurement' && state.attributes['device_class'] === 'voltage' && battery) return; // Skip electricalSensor voltage sensor if the device is battery powered
      const attachElectricalMeasurement = hassDomainSensor.deviceType === electricalSensor && electricalMeasurementEndpoint !== undefined;
      if (attachElectricalMeasurement) {
        endpointName = electricalMeasurementEndpoint;
        platform.log.debug(
          `- electrical sensor domain ${hassDomainSensor.domain} stateClass ${hassDomainSensor.withStateClass} deviceClass ${hassDomainSensor.withDeviceClass} endpoint '${CYAN}${endpointName}${db}' for entity ${CYAN}${entity.entity_id}${db}`,
        );
      } else if (hassDomainSensor.endpoint === undefined) {
        endpointName = entity.entity_id; // Use the entity ID as the endpoint name
      } else {
        endpointName = hassDomainSensor.endpoint; // Remap the endpoint name for the entity
        platform.log.debug(
          `- sensor domain ${hassDomainSensor.domain} stateClass ${hassDomainSensor.withStateClass} deviceClass ${hassDomainSensor.withDeviceClass} endpoint '${CYAN}${endpointName}${db}' for entity ${CYAN}${entity.entity_id}${db}`,
        );
      }
      platform.log.debug(`+ sensor device ${CYAN}${hassDomainSensor.deviceType.name}${db} cluster ${CYAN}${getClusterNameById(hassDomainSensor.clusterId)}${db}`);
      if (!attachElectricalMeasurement) mutableDevice.addDeviceTypes(endpointName, hassDomainSensor.deviceType);
      mutableDevice.addClusterServerIds(endpointName, hassDomainSensor.clusterId);
      if (!attachElectricalMeasurement && isValidString(state.attributes['friendly_name'])) mutableDevice.setFriendlyName(endpointName, state.attributes['friendly_name']);
      platform.log.debug(`- state ${debugStringify(state)}`);
    });
  return endpointName;
}

/**
 * Returns the endpoint of the only outlet entity in a device.
 *
 * @param {HassEntity[]} entities - The eligible entities belonging to a Home Assistant device
 * @returns {string | undefined} - The single outlet entity ID, if exactly one exists; otherwise, undefined
 */
export function getSingleOutletEndpoint(entities: HassEntity[]): string | undefined {
  const outlets = entities.filter((entity) => getDomain(entity.entity_id) === 'switch' && !isServiceSwitch(entity));
  return outlets.length === 1 ? outlets[0].entity_id : undefined;
}

/**
 * Returns whether a switch is a Home Assistant configuration or diagnostic control.
 *
 * @param {HassEntity} entity - The Home Assistant entity to inspect
 * @returns {boolean} True when the switch is a service control rather than an outlet
 */
export function isServiceSwitch(entity: HassEntity): boolean {
  return getDomain(entity.entity_id) === 'switch' && ['config', 'diagnostic'].includes(entity.entity_category ?? '');
}

/**
 * Finds the sole cumulative energy sensor that is safe to map to Matter imported energy.
 *
 * Period-based statistics reset and must not overwrite the device's cumulative import value.
 * When more than one non-period cumulative sensor exists, no sensor is selected to avoid an
 * ambiguous mapping.
 *
 * @param {HassEntity[]} entities - The eligible entities belonging to a Home Assistant device
 * @param {(entity: HassEntity) => HassState | undefined} getState - Resolves the current Home Assistant state for an entity
 * @returns {string | null} The entity ID of the sole cumulative energy sensor, or null when none is safe
 */
export function getCumulativeEnergyEntity(entities: HassEntity[], getState: (entity: HassEntity) => HassState | undefined): string | null {
  const periodName = /(?:^|[_.\s-])(today|yesterday|daily|week(?:ly)?|month(?:ly)?|year(?:ly)?)(?:$|[_.\s-])/i;
  const candidates = entities.filter((entity) => {
    const state = getState(entity);
    const identity = `${entity.entity_id} ${entity.name ?? ''} ${entity.original_name ?? ''}`;
    return (
      getDomain(entity.entity_id) === 'sensor' &&
      state?.attributes['state_class'] === 'total_increasing' &&
      state.attributes['device_class'] === 'energy' &&
      !periodName.test(identity)
    );
  });
  return candidates.length === 1 ? candidates[0].entity_id : null;
}
