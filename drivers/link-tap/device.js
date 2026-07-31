/* jslint node: true */

'use strict';

const Homey = require('homey');

class LinkTapDevice extends Homey.Device
{

    toFiniteNumber(value)
    {
        const num = Number(value);
        return Number.isFinite(num) ? num : undefined;
    }

    getWateringVolumeLimitLitres()
    {
        const limit = this.toFiniteNumber(this.getSetting('watering_volume_limit'));
        if (limit === undefined)
        {
            return 0;
        }

        return Math.max(0, limit);
    }

    getStoredWaterTotalCubicMetres()
    {
        const storedTotal = this.toFiniteNumber(this.waterTotal);
        if (storedTotal === undefined)
        {
            return 0;
        }

        return Math.max(0, storedTotal);
    }

    syncStoredTotalFromCapability(source)
    {
        const currentStoredTotal = this.getStoredWaterTotalCubicMetres();
        const currentCapabilityTotal = this.toFiniteNumber(this.getCapabilityValue('meter_water.total'));

        if ((currentCapabilityTotal !== undefined) && (currentCapabilityTotal > currentStoredTotal))
        {
            this.waterTotal = currentCapabilityTotal;
            this.setStoreValue('waterTotal', this.waterTotal);
            this.homey.app.updateLog(`syncStoredTotalFromCapability (${source}) updated stored total to ${this.waterTotal} m3`);
        }
    }

    updateTotalWaterUsed(sessionVolumeLitres, persistToStore, source)
    {
        const storedTotal = this.getStoredWaterTotalCubicMetres();
        const sessionVolume = this.toFiniteNumber(sessionVolumeLitres);
        const sessionCandidateTotal = ((sessionVolume !== undefined) && (sessionVolume > 0))
            ? storedTotal + (sessionVolume / 1000)
            : storedTotal;
        const currentCapabilityTotal = this.toFiniteNumber(this.getCapabilityValue('meter_water.total'));
        const nextTotal = Math.max(
            storedTotal,
            sessionCandidateTotal,
            (currentCapabilityTotal !== undefined) ? currentCapabilityTotal : 0,
        );

        this.setCapabilityValueLog('meter_water.total', nextTotal).catch(this.error);

        if (persistToStore && (nextTotal > storedTotal))
        {
            this.waterTotal = nextTotal;
            this.setStoreValue('waterTotal', this.waterTotal);
            this.homey.app.updateLog(`updateTotalWaterUsed (${source}) persisted total ${this.waterTotal} m3`);
        }
    }

    updatePlanWaterUsed(sessionVolumeLitres, source, allowDecrease = false)
    {
        const currentPlanVolume = this.toFiniteNumber(this.getCapabilityValue('meter_water'));
        const currentValue = (currentPlanVolume !== undefined) ? Math.max(0, currentPlanVolume) : 0;
        const reportedValue = this.toFiniteNumber(sessionVolumeLitres);
        const reported = (reportedValue !== undefined) ? Math.max(0, reportedValue) : 0;
        const nextValue = allowDecrease ? reported : Math.max(currentValue, reported);

        this.setCapabilityValueLog('meter_water', nextValue).catch(this.error);
        this.homey.app.updateLog(`updatePlanWaterUsed (${source}) current: ${currentValue}L, reported: ${reported}L, next: ${nextValue}L`);
        return nextValue;
    }

    isManualModeActive()
    {
        return this.getCapabilityValue('watering_mode') === 'M';
    }

    async stopManualModeForVolumeLimit(currentVolume, source)
    {
        const limit = this.getWateringVolumeLimitLitres();
        if (limit <= 0)
        {
            return;
        }

        if (!this.isManualModeActive())
        {
            return;
        }

        if (!Number.isFinite(currentVolume) || (currentVolume < limit))
        {
            return;
        }

        if (this.volumeLimitStopPending)
        {
            return;
        }

        this.volumeLimitStopPending = true;
        this.homey.app.updateLog(`stopManualModeForVolumeLimit (${source}) reached ${currentVolume}L (limit ${limit}L)`);

        try
        {
            await this.activateInstantMode(false);
        }
        catch (err)
        {
            this.volumeLimitStopPending = false;
            this.homey.app.updateLog(`stopManualModeForVolumeLimit failed: ${err.message}`, 0);
        }
    }

    async setAvailableLog(reason)
    {
        this.homey.app.updateLog(`setAvailable ${reason}`);
        try
        {
            await this.setAvailable();
        }
        catch (err)
        {
            this.homey.app.updateLog(`setAvailable error ${reason} ${err.message}`);
        }
    }

    async setUnavailableLog(reason, message)
    {
        this.homey.app.updateLog(`setUnavailable ${reason}: ${message}`);
        try
        {
            await this.setUnavailable(message);
        }
        catch (err)
        {
            this.homey.app.updateLog(`setUnavailable error ${reason} ${err.message}`);
        }
    }

    /**
     * onInit is called when the device is initialized.
     */
    async onInit()
    {
        this.log('LinkTapDevice initialising');
        this.cycles = 0;
        this.abortTimer = null;
        this.previousWateringMode = null;
        this.gatewayOnlineGraceUntil = 0;
        this.lastFlowActivityAt = 0;
        this.volumeLimitStopPending = false;
        this.updateRetryTimer = null;
        this.gatewayRecoveryTimer = null;

        this.onDeviceUpdateVol = this.onDeviceUpdateVol.bind(this);
        this.abortWatering = this.abortWatering.bind(this);

        this.username = this.getStoreValue('username');
        this.apiKey = this.getStoreValue('apiKey');
        this.type = this.getStoreValue('type');
        this.waterTotal = this.getStoreValue('waterTotal');
        this.totalWaterMigrationDone = this.getStoreValue('totalWaterMigrationDone') === true;

        this.volUnits = this.getSetting('volume_units');
        if (!this.waterTotal)
        {
            this.waterTotal = 0;
        }

        this.syncStoredTotalFromCapability('onInit');

        // Old devices used the global credentials so use those if the local ones are not defined
        if (!this.apiKey)
        {
            // Update the values
            this.apiKey = this.homey.app.apiKey;
            this.username = this.homey.app.username;

            this.setStoreValue('username', this.username);
            this.setStoreValue('apiKey', this.apiKey);
        }

        // Check the connection with the credentials
        if (!await this.homey.app.registerWebhookURL(this.apiKey, this.username))
        {
            // No good. Check if the global API key is different for the same usernam
            if ((this.apiKey !== this.homey.app.apiKey) && (this.username === this.homey.app.username))
            {
                // The device store values are not good so try the app ones
                this.apiKey = this.homey.app.apiKey;
                if (!await this.homey.app.registerWebhookURL(this.apiKey, this.username))
                {
                    // Still no good
                    await this.setUnavailableLog('onInit registerWebhookURL retry failed', this.homey.__('connectionFailed'));
                }
                else
                {
                    // Connect OK so save the API key
                    this.setStoreValue('apiKey', this.apiKey);
                }
            }
            else
            {
                await this.setUnavailableLog('onInit registerWebhookURL failed', this.homey.__('connectionFailed'));
            }
        }

        const dd = this.getData();
        this.homey.app.registerHomeyWebhook(dd.gatewayId);

        if (!this.hasCapability('onoff'))
        {
            await this.addCapabilityLog('onoff');
            await this.setCapabilityValueLog('onoff', false);
        }

        if (!this.hasCapability('clear_alarms'))
        {
            await this.addCapabilityLog('clear_alarms').catch(this.error);
        }

        if (!this.hasCapability('time_elapsed'))
        {
            await this.addCapabilityLog('time_elapsed');
            await this.setCapabilityValueLog('time_elapsed', 0);

            // Ensure the correct tite is set for the time_remaining as it might have been changed by the old version
            await this.setCapabilityOptions('time_remaining', { title: this.homey.__('timeRemaining') });
        }

        if (!this.hasCapability('alarm_freeze'))
        {
            await this.addCapabilityLog('alarm_freeze');
            await this.setCapabilityValueLog('alarm_freeze', false);
        }

        if (this.hasCapability('signal_strength'))
        {
            // Signal strength is no longer part of the API that we use
            await this.removeCapabilityLog('signal_strength');
        }

        if (this.hasCapability('alarm_battery'))
        {
            await this.removeCapabilityLog('alarm_battery');
            await this.addCapabilityLog('measure_battery');
        }

        if (this.hasCapability('meter_water') && !this.hasCapability('meter_water.total'))
        {
            await this.addCapabilityLog('meter_water.total');
        }

        await this.setCapabilityValueLog('cycles_remaining', 0);
        await this.setCapabilityValueLog('time_remaining', 0);
        await this.setCapabilityValueLog('time_elapsed', 0);

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('clear_alarms', this.onCapabilityClearAlarms.bind(this));
        this.registerCapabilityListener('watering_mode', this.onCapabilityWateringMode.bind(this));
        this.registerCapabilityListener('button.send_log', this.onCapabilitySedLog.bind(this));

        if (this.hasCapability('meter_water.total'))
        {
            const totalWaterTitle = this.homey.__('totalWaterUsed');
			let options = null;
			try
			{
				options = this.getCapabilityOptions('meter_water.total');
			}
			catch (err)
			{
			}

            if (!options || !options.title || options.title !== totalWaterTitle || options.units !== 'm³')
            {
                this.setCapabilityOptions('meter_water.total', { title: totalWaterTitle, units: 'm³' });

                // One-time migration from legacy litres storage to cubic metres.
                if (!this.totalWaterMigrationDone)
                {
                    this.waterTotal /= 1000;
                    this.setStoreValue('waterTotal', this.waterTotal);
                    this.setStoreValue('totalWaterMigrationDone', true);
                    this.totalWaterMigrationDone = true;
                }

                this.setCapabilityValue('meter_water.total', this.waterTotal).catch(this.error);
            }
        }

        // Try to fetch the initial values
        this.updateDeviceValues();

        this.log('LinkTapDevice has been initialized');
    }

    /**
     * onAdded is called when the user adds the device, called just after pairing.
     */
    async onAdded()
    {
        this.log('LinkTapDevice has been added');

        // Try to fetch the initial values
        this.updateDeviceValues();
    }

    /**
     * onSettings is called when the user updates the device's settings.
     * @param {object} event the onSettings event data
     * @param {object} event.oldSettings The old settings object
     * @param {object} event.newSettings The new settings object
     * @param {string[]} event.changedKeys An array of keys changed since the previous version
     * @returns {Promise<string|void>} return a custom message that will be displayed
     */
    async onSettings({ oldSettings, newSettings, changedKeys })
    {
        this.log('LinkTapDevice settings where changed');

        if (changedKeys.includes('watering_volume_limit'))
        {
            const limit = this.getWateringVolumeLimitLitres();
            this.homey.app.updateLog(`onSettings watering_volume_limit: ${limit}L`);
        }
    }

    /**
     * onRenamed is called when the user updates the device's name.
     * This method can be used this to synchronise the name to the device.
     * @param {string} name The new name
     */
    async onRenamed(name)
    {
        this.log('LinkTapDevice was renamed');
    }

    /**
     * onDeleted is called when the user deleted the device.
     */
    async onDeleted()
    {
        this.log('LinkTapDevice has been deleted');
    }

    async updateDeviceValues(forceRefresh = false)
    {
        if (this.updateRetryTimer)
        {
            this.homey.clearTimeout(this.updateRetryTimer);
            this.updateRetryTimer = null;
        }

        if (forceRefresh && this.homey.app.invalidateDeviceDataCache)
        {
            this.homey.app.invalidateDeviceDataCache('force refresh requested');
        }

        const success = await this.__updateDeviceValues();
        if (!success)
        {
            this.homey.app.updateLog('updateDeviceValues retry in 5 minutes');

            // Try again after 5 minutes as it could be failing with the cached data
            this.updateRetryTimer = this.homey.setTimeout(() =>
            {
                this.updateRetryTimer = null;
                this.updateDeviceValues();
            }, 1000 * 60 * 5);
        }

        return success;
    }

    async __updateDeviceValues()
    {
        this.homey.app.updateLog('updateDeviceValues');

        const body = {
            apiKey: this.apiKey,
            username: this.username,
        };

        // Only use fresh data or a cache entry that is still known to be clean.
        // Dirty cache snapshots can lag behind webhook activity and incorrectly mark
        // a device offline immediately after watering/gateway recovery events.
        const devices = await this.homey.app.getDeviceData(false, body);

        if (devices === null)
        {
            this.homey.app.updateLog('updateDeviceValues no new device data available');
            return false;
        }

        const dd = this.getData();

        try
        {
            const gateway = devices.find((gateway) => gateway.gatewayId === dd.gatewayId);

            if (gateway.status !== 'Connected')
            {
                this.homey.app.updateLog('updateDeviceValues Gateway status is not connected');
                await this.setUnavailableLog('updateDeviceValues gateway offline', this.homey.__('gwOffline'));
                return false;
            }

            const tapLinkers = gateway.taplinker;
            const tapLinker = tapLinkers.find((tapLinkerEntry) => tapLinkerEntry.taplinkerId === dd.id);
            if (tapLinker === undefined)
            {
                this.homey.app.updateLog(`updateDeviceValues (${dd.id}) Device not found in gateway`);
                await this.setUnavailableLog(`updateDeviceValues ${dd.id} not found`, this.homey.__('notFound'));
                return false;
            }
            this.homey.app.updateLog(`updateDeviceValues (${dd.id}) response: ${this.homey.app.varToString(tapLinker)}`);

            if (tapLinker.status !== 'Connected')
            {
                this.homey.app.updateLog('updateDeviceValues Valve status is not connected');
                await this.setUnavailableLog(`updateDeviceValues ${dd.id} valve offline`, this.homey.__('ltOffline'));
                return false;
            }

            await this.setAvailableLog(`updateDeviceValues ${dd.id} connected`);

            this.type = tapLinker.dType;
            this.setStoreValue('type', this.type);

            // Standard capabilities available to all device types
            await this.setCapabilityValueLog('watering_mode', tapLinker.workMode !== 'N' ? tapLinker.workMode : null);

            const apiWateringState = (tapLinker.watering === true)
                ? true
                : ((tapLinker.watering === false) ? false : null);
            const localPlanActive = this.getCapabilityValue('watering') === true;
            const localValveActive = this.getCapabilityValue('water_on') === true;
            const ecoCyclePauseActive = (tapLinker.workMode === 'M')
                && localPlanActive
                && Number.isFinite(this.cycles)
                && (this.cycles > 0)
                && (apiWateringState === false);

            const planActive = (apiWateringState === null)
                ? localPlanActive
                : (ecoCyclePauseActive ? true : apiWateringState);
            const valveActive = (apiWateringState === null) ? localValveActive : (apiWateringState === true);

            if (ecoCyclePauseActive)
            {
                this.homey.app.updateLog(`updateDeviceValues (${dd.id}) preserving onoff during instant ECO pause (cycles remaining: ${this.cycles})`);
            }

            this.setCapabilityValueLog('onoff', planActive);
            this.setCapabilityValueLog('measure_battery', parseInt(tapLinker.batteryStatus, 10));
            this.setCapabilityValueLog('alarm_freeze', false);
            this.setCapabilityValueLog('watering', planActive);
            this.setCapabilityValueLog('water_on', valveActive);

            // Some capabilities are only available on G2 models
            if ((this.type === 5) || (this.type === 10))
            {

                // G2 or G2S
                if (!this.hasCapability('alarm_fallen'))
                {
                    await this.addCapabilityLog('alarm_fallen');
                    await this.setCapabilityValueLog('alarm_fallen', tapLinker.fall);
                }

                if (!this.hasCapability('alarm_broken'))
                {
                    await this.addCapabilityLog('alarm_broken');
                    await this.setCapabilityValueLog('alarm_broken', tapLinker.valveBroken);
                }
            }
            else
            if (this.hasCapability('alarm_fallen'))
                {
                    await this.removeCapabilityLog('alarm_fallen');
                }

            // Some capabilities are only available when a flow meter is fitted.
            await this.setupFlowMeterCapabilities(tapLinker.flowMeterStatus);

            if (tapLinker.flowMeterStatus === 'on')
            {
                await this.setCapabilityValueLog('alarm_water', tapLinker.noWater);
                await this.setCapabilityValueLog('measure_water', tapLinker.vel / 1000);
                const localWatering = this.getCapabilityValue('watering') === true;
                const localWaterOn = this.getCapabilityValue('water_on') === true;
                const recentFlowActive = (Date.now() - this.lastFlowActivityAt) < (1000 * 120);
                this.homey.app.updateLog(`updateDeviceValues (${dd.id}) meter_water preserved (api watering: ${tapLinker.watering}, local watering: ${localWatering}, local water_on: ${localWaterOn}, recent flow: ${recentFlowActive}, current: ${this.getCapabilityValue('meter_water')})`);
                await this.setCapabilityValueLog('alarm_high_flow', tapLinker.leakFlag);
                await this.setCapabilityValueLog('alarm_low_flow', tapLinker.clogFlag);
            }
        }
        catch (err)
        {
            this.homey.app.updateLog(`updateDeviceValues (${dd.id}) Error: ${err.message}`, 0);
            return false;
        }

        return true;
    }

    async setupFlowMeterCapabilities(FlowMeterConnected)
    {
        this.homey.app.updateLog(`setupFlowMeterCapabilities: ${FlowMeterConnected}`);

        if (FlowMeterConnected === 'on')
        {
            // Flow meter is connected so make sure we have all the capabilities

            if (!this.hasCapability('measure_water'))
            {
                await this.addCapabilityLog('measure_water');
            }

            if (!this.hasCapability('meter_water'))
            {
                await this.addCapabilityLog('meter_water');
            }

            if (!this.hasCapability('meter_water.total'))
            {
                await this.addCapabilityLog('meter_water.total');
				this.setCapabilityOptions('meter_water.total', { title: this.homey.__('totalWaterUsed'), units: 'm³' });
				this.setCapabilityValueLog('meter_water.total', this.waterTotal).catch(this.error);
            }

            if (!this.hasCapability('alarm_water'))
            {
                await this.addCapabilityLog('alarm_water');
            }

            if (!this.hasCapability('alarm_high_flow'))
            {
                await this.addCapabilityLog('alarm_high_flow');
            }

            if (!this.hasCapability('alarm_low_flow'))
            {
                await this.addCapabilityLog('alarm_low_flow');
            }
        }
        else
        {
            if (this.hasCapability('alarm_water'))
            {
                await this.removeCapabilityLog('alarm_water');
            }

            if (this.hasCapability('measure_water'))
            {
                await this.removeCapabilityLog('measure_water');
            }

            if (this.hasCapability('meter_water'))
            {
                await this.removeCapabilityLog('meter_water');
            }

            if (this.hasCapability('meter_water.total'))
            {
                await this.removeCapabilityLog('meter_water.total');
            }

            if (this.hasCapability('alarm_high_flow'))
            {
                await this.removeCapabilityLog('alarm_high_flow');
            }

            if (this.hasCapability('alarm_low_flow'))
            {
                await this.removeCapabilityLog('alarm_low_flow');
            }
        }
    }

    async onCapabilityClearAlarms(value)
    {
        // Send a message for each active alarm to clear it
        const dd = this.getData();
        const url = 'dismissAlarm';
        const body = {
            gatewayId: dd.gatewayId,
            taplinkerId: dd.id,
            alarm: '',
            apiKey: this.apiKey,
            username: this.username,
        };

        if (this.hasCapability('alarm_water') && this.getCapabilityValue('alarm_water'))
        {
            body.alarm = 'noWater';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.hasCapability('alarm_broken') && this.getCapabilityValue('alarm_broken'))
        {
            body.alarm = 'valveBroken';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.hasCapability('alarm_fallen') && this.getCapabilityValue('alarm_fallen'))
        {
            body.alarm = 'fallFlag';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.hasCapability('alarm_low_flow') && this.getCapabilityValue('alarm_low_flow'))
        {
            body.alarm = 'pcFlag';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.hasCapability('alarm_high_flow') && this.getCapabilityValue('alarm_high_flow'))
        {
            body.alarm = 'pbFlag';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        this.setCapabilityValueLog('alarm_freeze', false).catch(this.error);
    }

    async onCapabilitySedLog(value)
    {
        const body = {
            notify: true,
            logType: 'diag',
        };

        this.homey.app.sendLog(body);
    }

    async onCapabilityOnOff(value)
    {
        // Instant mode
        this.homey.app.updateLog(`onCapabilityOnOff ${value}`);

        const settings = this.getSettings();
        return this.activateInstantMode(value,
            settings.watering_duration,
            settings.eco_mode,
            settings.on_duration,
            settings.off_duration,
            settings.revert);
    }

    async onCapabilityWateringMode(value)
    {
        this.homey.app.updateLog(`onCapabilityWateringMode ${value}`);

        if (value === 'M')
        {
            // Instant mode
            const settings = this.getSettings();
            return this.activateInstantMode(true,
                settings.watering_duration,
                settings.eco_mode,
                settings.on_duration,
                settings.off_duration,
                settings.revert);
        }

        // All other modes
        return this.activateWateringMode(value);
    }

    async activateWateringMode(mode)
    {
        this.homey.app.updateLog(`activateWateringMode ${mode}`);

        const dd = this.getData();
        let url;
        const body = {
            gatewayId: dd.gatewayId,
            taplinkerId: dd.id,
            apiKey: this.apiKey,
            username: this.username,
        };

        if (mode === 'I')
        {
            url = 'activateIntervalMode';
        }
        else if (mode === 'O')
        {
            url = 'activateOddEvenMode';
        }
        else if (mode === 'T')
        {
            url = 'activateSevenDayMode';
        }
        else if (mode === 'Y')
        {
            url = 'activateMonthMode';
        }
        else if (mode === 'D')
        {
            url = 'activateCalendarMode';
        }

        this.homey.app.updateLog(`activateWateringMode resolved endpoint: ${url || 'unknown'}`);

        try
        {
            this.homey.app.updateLog(`activateWateringMode mode: ${mode}`);

            const response = await this.homey.app.PostURL(url, body);
            this.homey.app.updateLog(`activateWateringMode response: ${this.homey.app.varToString(response)}`);
            if (response.result !== 'ok')
            {
                throw (new Error(response.result));
            }
        }
        catch (err)
        {
            if (err.message === 'HTTPS Error - 400')
            {
                const errMsg = this.homey.__(`wateringModeUndefined.${mode}`);
                throw (new Error(errMsg));
            }
            if (err.message === 'HTTPS Error - 404')
            {
                const errMsg = this.homey.__(`wateringModeNotSupported.${mode}`);
                throw (new Error(errMsg));
            }
            throw (new Error(err.message));
        }
    }

    async activateInstantMode(onOff, duration, ecoOption, ecoOn, ecoOff, autoBack)
    {
        this.homey.app.updateLog(`activateInstantMode ${onOff}, duration: ${duration}, ecoOption: ${ecoOption}, ecoOn: ${ecoOn}, ecoOff: ${ecoOff}, autoBack: ${autoBack}`);

        const url = 'activateInstantMode';
        const dd = this.getData();
        const body = {
            gatewayId: dd.gatewayId,
            taplinkerId: dd.id,
            action: false,
            duration: 0,
            apiKey: this.apiKey,
            username: this.username,
        };

        if (onOff)
        {
            body.action = true;
            this.volumeLimitStopPending = false;

            if (!duration)
            {
                duration = 5;
            }

            body.duration = duration;

            const volumeLimit = this.getWateringVolumeLimitLitres();
            const useEcoMode = ecoOption && (volumeLimit <= 0);
            if (ecoOption && !useEcoMode)
            {
                this.homey.app.updateLog(`activateInstantMode eco mode disabled because watering_volume_limit is active (${volumeLimit}L)`);
            }

            if (useEcoMode)
            {
                if (ecoOn > duration)
                {
                    throw (new Error('Eco On must be shorter than Duration'));
                }

                body.eco = true;
                body.ecoOn = ecoOn;
                body.ecoOff = ecoOff;
                this.cycles = Math.ceil(duration / ecoOn);
            }
            else
            {
                this.cycles = 1;
                body.eco = false;
            }
            body.autoBack = autoBack;
            if (autoBack)
            {
                this.capturePreviousWateringMode();
                this.homey.app.updateLog(`activateInstantMode autoBack enabled. Captured mode: ${this.previousWateringMode || 'none'}`);
            }
            else
            {
                if (this.previousWateringMode)
                {
                    this.homey.app.updateLog(`activateInstantMode autoBack disabled. Clearing previous mode: ${this.previousWateringMode}`);
                }
                this.previousWateringMode = null;
            }
        }
        else
        {
            this.volumeLimitStopPending = false;

            // Cancel watering doesn't generate the 'watering end' webhook event when Eco mode is active so setup a backup to tidy up
            this.abortTimer = this.homey.setTimeout(() =>
            {
                // Switch of watering if no activity for 1 minute
                this.abortWatering();
            }, 1000 * 60 * 1);
        }

        this.homey.app.updateLog(`activateInstantMode onOff: ${onOff}`);

        const response = await this.homey.app.PostURL(url, body);
        this.homey.app.updateLog(`activateInstantMode response: ${this.homey.app.varToString(response)}`);
        if (response.result !== 'ok')
        {
            throw (new Error(response.result));
        }
    }

    abortWatering()
    {
        if (this.abortTimer)
        {
            this.homey.clearTimeout(this.abortTimer);
            this.abortTimer = null;
        }

        this.homey.app.updateLog('abortWatering');
        this.volumeLimitStopPending = false;

        if (this.timerVolUpdate)
        {
            this.homey.clearInterval(this.timerVolUpdate);
            this.timerVolUpdate = null;
        }

        this.setCapabilityValueLog('water_on', false).catch(this.error);
        this.setCapabilityValueLog('time_remaining', 0).catch(this.error);
        // this.setCapabilityValueLog('time_elapsed', 0).catch(this.error);

        this.cycles = 0;
        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);

        this.setCapabilityValueLog('watering', false).catch(this.error);
        this.setCapabilityValueLog('onoff', false).catch(this.error);
        this.setCapabilityValueLog('measure_water', 0).catch(this.error);
        this.driver.triggerWateringFinished(this);
        this.restorePreviousWateringMode().catch(this.error);
    }

    capturePreviousWateringMode()
    {
        const mode = this.getCapabilityValue('watering_mode');

        // Only capture scheduled modes. Keep a previously captured value while in manual mode.
        if (mode && mode !== 'M')
        {
            this.previousWateringMode = mode;
            this.homey.app.updateLog(`capturePreviousWateringMode stored: ${mode}`);
        }
        else
        {
            this.homey.app.updateLog(`capturePreviousWateringMode skipped. Current mode: ${mode || 'unset'}, previous mode: ${this.previousWateringMode || 'unset'}`);
        }
    }

    async restorePreviousWateringMode()
    {
        const mode = this.previousWateringMode;

        // Delay the API query so that all wateringOff messages are processed first.
        this.homey.setTimeout(async () =>
        {
            const refreshSuccess = await this.updateDeviceValues(true);
            if (!refreshSuccess)
            {
                this.homey.app.updateLog('restorePreviousWateringMode refresh failed');
                return;
            }

            if (!mode)
            {
                this.homey.app.updateLog('restorePreviousWateringMode skipped: no previous mode stored');
                return;
            }

            const currentMode = this.getCapabilityValue('watering_mode');
            if (currentMode === 'M')
            {
                // If the device is still in manual mode, explicitly restore the last schedule mode.
                this.homey.app.updateLog(`restorePreviousWateringMode restoring: ${mode}`);
                try
                {
                    await this.activateWateringMode(mode);
                    this.homey.app.updateLog(`restorePreviousWateringMode success: ${mode}`);
                }
                catch (err)
                {
                    this.homey.app.updateLog(`restorePreviousWateringMode failed: ${err.message}`, 0);
                    return;
                }
            }
            else
            {
                this.homey.app.updateLog(`restorePreviousWateringMode not needed. Current mode: ${currentMode || 'unset'}`);
            }

            this.previousWateringMode = null;
        }, 1000 * 5);
    }

    async onDeviceUpdateVol()
    {
        const vel = this.getCapabilityValue('measure_water');
        const currentVol = this.toFiniteNumber(this.getCapabilityValue('meter_water'));
        const currentPlanVolume = (currentVol !== undefined) ? currentVol : 0;
        const velocity = this.toFiniteNumber(vel);
        const flowVelocity = (velocity !== undefined) ? Math.max(0, velocity) : 0;
        const vol = currentPlanVolume + (flowVelocity / 30);
        this.lastFlowActivityAt = Date.now();
        this.updatePlanWaterUsed(vol, 'flowUpdate');
        this.updateTotalWaterUsed(vol, false, 'flowUpdate');
        this.stopManualModeForVolumeLimit(vol, 'flowUpdate').catch(this.error);
    }

    async processWebhookMessage(message)
    {
        try
        {
            const dd = this.getData();
            const event = message.event ? message.event : message.msg;
            const isGatewayEvent = (event === 'gatewayOnline') || (event === 'gatewayOffline');
            const messageGatewayId = message.gatewayId || message.gatewayID;
            const messageDeviceId = message.deviceId || message.taplinkerId || message.tapLinkerId;
            const isForThisDevice = (String(dd.gatewayId) === String(messageGatewayId))
                && (isGatewayEvent || (String(dd.id) === String(messageDeviceId)));

            if (isForThisDevice)
            {
                // message is for this device
                this.homey.app.updateLog(`processWebhookMessage ${event}`);

                if (event === 'watering start')
                {
                    // A watering plan has started or or manual mode was turned on
                    this.setAvailableLog('processWebhookMessage watering start').catch(this.error);
                    this.lastFlowActivityAt = Date.now();
                    this.setCapabilityValueLog('meter_water', 0).catch(this.error);
                    this.setCapabilityValueLog('measure_water', 0).catch(this.error);

                    if (message.workMode === 'M')
                    {
                        // Manual mode can be started externally, so remember the previous schedule mode.
                        this.capturePreviousWateringMode();
                        this.homey.app.updateLog(`processWebhookMessage manual start. previous mode: ${this.previousWateringMode || 'none'}`);
                    }

                    if (this.abortTimer)
                    {
                        this.homey.clearTimeout(this.abortTimer);
                        this.abortTimer = null;
                    }

                    this.setCapabilityValueLog('onoff', true).catch(this.error);
                    this.setCapabilityValueLog('watering', true).catch(this.error);
                    this.volumeLimitStopPending = false;
                    this.activeTime = 0;
                    this.setCapabilityValueLog('watering_mode', message.workMode);
                    this.driver.triggerWateringStarted(this);
                }
                else if (event === 'wateringOn')
                {
                    // The water flow (valve) has turned on (also occurs about once per minute)
                    this.setAvailableLog('processWebhookMessage wateringOn').catch(this.error);
                    this.lastFlowActivityAt = Date.now();
                    const planStarting = this.getCapabilityValue('watering') !== true;
                    if (planStarting)
                    {
                        this.setCapabilityValueLog('meter_water', 0).catch(this.error);
                    }
                    this.setCapabilityValueLog('water_on', true).catch(this.error);
                    this.setCapabilityValueLog('onoff', true).catch(this.error);
                    this.setCapabilityValueLog('watering', true).catch(this.error);

                    if (message.ecoFlag === 1)
                    {
                        // The ecoFlag is set so the water will switch off / on during the plan so calculate the number of times it will happens
                        // totalMin is the total request watering time (valve on)
                        // ecoTotal is the time it will turn on for each cycle
                        this.cycles = Math.ceil(message.ecoTotal / message.totalMin);
                        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);

                        if (message.onMin === message.totalMin)
                        {
                            // Manual mode was started so the time reported will be the run time instead of time remaining as the total time is unknown
                            this.manualWateringMode = false;
                        }
                    }
                    else if (message.ecoFlag !== 3)
                    {
                        this.cycles = 1;
                        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);
                        if ((message.onMin === 0) && (message.totalMin === -1))
                        {
                            // Turned on via the button
                            this.manualWateringMode = true;
                            this.setCapabilityValueLog('time_remaining', null).catch(this.error);
                        }
                    }

                    if (this.manualWateringMode)
                    {
                        // Elapsed time is reported during manual mode
                        const elapsed = this.toFiniteNumber(message.onMin);
                        if (elapsed !== undefined)
                        {
                            this.setCapabilityValueLog('time_elapsed', elapsed).catch(this.error);
                        }
                        else
                        {
                            this.homey.app.updateLog('processWebhookMessage skip time_elapsed: message.onMin is not a finite number');
                        }
                    }
                    else
                    {
                        // Remaining time is reported for a plan
                        const elapsed = this.toFiniteNumber(this.activeTime);
                        if (elapsed !== undefined)
                        {
                            this.setCapabilityValueLog('time_elapsed', elapsed).catch(this.error);
                            this.activeTime = elapsed + 1;
                        }
                        else
                        {
                            this.homey.app.updateLog('processWebhookMessage skip time_elapsed: activeTime is not a finite number');
                            this.activeTime = 0;
                        }

                        const remaining = this.toFiniteNumber(message.onMin);
                        if (remaining !== undefined)
                        {
                            this.setCapabilityValueLog('time_remaining', remaining).catch(this.error);
                        }
                        else
                        {
                            this.homey.app.updateLog('processWebhookMessage skip time_remaining: message.onMin is not a finite number');
                        }
                    }

                    if (message.vol !== undefined)
                    {
                        this.lastFlowActivityAt = Date.now();
                        const vol = message.vol / 1000;
                        this.updatePlanWaterUsed(vol, 'wateringOn', planStarting);
                        this.updateTotalWaterUsed(vol, false, 'wateringOn');

                        this.setCapabilityValueLog('measure_water', message.vel / 1000).catch(this.error);

                        if (this.timerVolUpdate)
                        {
                            this.homey.clearInterval(this.timerVolUpdate);
                        }
                        this.timerVolUpdate = this.homey.setInterval(this.onDeviceUpdateVol, (1000 * 2));

                        this.stopManualModeForVolumeLimit(vol, 'wateringOn').catch(this.error);
                    }

                    if (message.battery)
                    {
                        this.setCapabilityValueLog('measure_battery', parseInt(message.battery, 10));
                    }

                }
                else if (event === 'wateringOff')
                {
                    this.setAvailableLog('processWebhookMessage wateringOff').catch(this.error);
                    this.volumeLimitStopPending = false;
                    this.homey.app.updateLog('processWebhookMessage wateringOff treated as plan finished');
                    this.setCapabilityValueLog('water_on', false).catch(this.error);
                    this.setCapabilityValueLog('time_remaining', 0).catch(this.error);

                    if (this.timerVolUpdate)
                    {
                        this.homey.clearInterval(this.timerVolUpdate);
                        this.timerVolUpdate = null;
                    }

                    if (message.vol !== undefined)
                    {
                        this.lastFlowActivityAt = Date.now();
                        const vol = message.vol / 1000;
                        this.updatePlanWaterUsed(vol, 'wateringOff');
                        this.updateTotalWaterUsed(vol, true, 'wateringOff');

                        this.setCapabilityValueLog('measure_water', 0).catch(this.error);
                    }
                    else
                    {
                        // Persist any runtime total value even if the final webhook has no volume payload.
                        this.updateTotalWaterUsed(undefined, true, 'wateringOff no volume');
                    }

                    if (!this.manualWateringMode)
                    {
                        const elapsed = this.toFiniteNumber(this.activeTime);
                        if (elapsed !== undefined)
                        {
                            this.setCapabilityValueLog('time_elapsed', elapsed).catch(this.error);
                        }
                        else
                        {
                            this.homey.app.updateLog('processWebhookMessage skip time_elapsed: activeTime is not a finite number (wateringOff)');
                        }
                    }

                    if (message.battery)
                    {
                        this.setCapabilityValueLog('measure_battery', parseInt(message.battery, 10));
                    }

                    // wateringOff indicates the full watering plan has finished.
                    this.cycles = 0;
                    this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);
                    this.setCapabilityValueLog('watering', false).catch(this.error);
                    this.setCapabilityValueLog('onoff', false).catch(this.error);
                    this.setCapabilityValueLog('measure_water', 0).catch(this.error);
                    this.driver.triggerWateringFinished(this);
                    this.restorePreviousWateringMode().catch(this.error);
                }
                else if (event === 'flowMeterValue')
                {
                    // A new water flow rate reading
                    this.lastFlowActivityAt = Date.now();
                    this.setCapabilityValueLog('measure_water', message.vel / 1000).catch(this.error);
                }
                else if (event === 'watering end')
                {
                    this.setAvailableLog('processWebhookMessage watering end').catch(this.error);
                    this.volumeLimitStopPending = false;
                    this.homey.app.updateLog(`processWebhookMessage watering end treated as cycle end only (cycles before: ${Number.isFinite(this.cycles) ? this.cycles : 'n/a'})`);
                    // In ECO mode this event is emitted at the end of each cycle.
                    // Treat it as valve-off only; full plan completion is handled by wateringOff.

                    if (this.timerVolUpdate)
                    {
                        this.homey.clearInterval(this.timerVolUpdate);
                        this.timerVolUpdate = null;
                    }

                    this.setCapabilityValueLog('water_on', false).catch(this.error);
                    this.setCapabilityValueLog('time_remaining', 0).catch(this.error);
                    this.setCapabilityValueLog('measure_water', 0).catch(this.error);

                    if (this.cycles > 0)
                    {
                        this.cycles--;
                        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);
                    }

                    this.homey.app.updateLog(`processWebhookMessage watering end cycle remaining: ${Number.isFinite(this.cycles) ? this.cycles : 'n/a'}`);
                }
                else if (event === 'watering cycle skipped')
                {
                    this.driver.triggerWateringSkipped(this);
                }
                else if (event === 'gatewayOnline')
                {
                    this.gatewayOnlineGraceUntil = Date.now() + (1000 * 10);

                    // Delay the API query so that all deviceOffline messages (which arrive ~700ms after
                    // gatewayOnline) are processed first. Without the delay our setAvailable() call would
                    // race against the incoming deviceOffline messages and lose. After 5 seconds the dust
                    // has settled and each device fetches its real status from the API.
                    if (this.gatewayRecoveryTimer)
                    {
                        this.homey.clearTimeout(this.gatewayRecoveryTimer);
                    }

                    this.gatewayRecoveryTimer = this.homey.setTimeout(() =>
                    {
                        this.gatewayRecoveryTimer = null;
                        this.updateDeviceValues(true);
                    }, 5000);
                }
                else if (event === 'gatewayOffline')
                {
                    await this.setUnavailableLog('processWebhookMessage gatewayOffline', this.homey.__('gwOffline'));
                }
                else if (event === 'deviceOffline')
                {
                    if (Date.now() < this.gatewayOnlineGraceUntil)
                    {
                        this.homey.app.updateLog('processWebhookMessage deviceOffline skipped during gateway recovery grace period');
                    }
                    else
                    {
                        await this.setUnavailableLog('processWebhookMessage deviceOffline', this.homey.__('ltOffline'));
                    }
                }
                else if (event === 'deviceOnline')
                {
                    await this.setAvailableLog('processWebhookMessage deviceOnline');
                    this.updateDeviceValues(true);
                }
                else if (event === 'battery low alert')
                {
                    this.setCapabilityValueLog('alarm_battery', 0).catch(this.error);
                }
                else if (event === 'battery good')
                {
                    this.setCapabilityValueLog('alarm_battery', 100).catch(this.error);
                }
                else if (event === 'water cut-off alert')
                {
                    this.setCapabilityValueLog('alarm_water', true).catch(this.error);
                }
                else if (event === 'unusually high flow alert')
                {
                    this.setCapabilityValueLog('alarm_high_flow', true).catch(this.error);
                }
                else if (event === 'unusually low flow alert')
                {
                    this.setCapabilityValueLog('alarm_low_flow', true).catch(this.error);
                }
                else if (event === 'valve broken alert')
                {
                    this.setCapabilityValueLog('alarm_broken', true).catch(this.error);
                }
                else if (event === 'device fall alert')
                {
                    this.setCapabilityValueLog('alarm_fallen', true).catch(this.error);
                }
                else if (event === 'manual button pressed')
                {
                    // Add a handler in here in the future
                }
                else if (event === 'freeze alert')
                {
                    this.setCapabilityValueLog('alarm_freeze', true).catch(this.error);
                }
                else if (event === 'alarm clear')
                {
                    if (message.title === 'noWater')
                    {
                        this.setCapabilityValueLog('alarm_water', false).catch(this.error);
                    }
                    else if (message.title === 'valveBroken')
                    {
                        this.setCapabilityValueLog('alarm_broken', false).catch(this.error);
                    }
                    else if (message.title === 'fallFlag')
                    {
                        this.setCapabilityValueLog('alarm_fallen', false).catch(this.error);
                    }
                    else if (message.title === 'pcFlag')
                    {
                        this.setCapabilityValueLog('alarm_low_flow', false).catch(this.error);
                    }
                    else if (message.title === 'pbFlag')
                    {
                        this.setCapabilityValueLog('alarm_high_flow', false).catch(this.error);
                    }
                }
                else if (event === 'flowMeterStatus')
                {
                    await this.setupFlowMeterCapabilities(message.status);
                    this.updateDeviceValues();
                }
            }
        }
        catch (err)
        {
            this.homey.app.updateLog(`processWebhookMessage error ${err.message}`);
        }
    }

    async setCapabilityValueLog(capability, value)
    {
        this.homey.app.updateLog(`setCapability ${capability}: ${value}`);
        try
        {
            await this.setCapabilityValue(capability, value);
        }
        catch (err)
        {
            this.homey.app.updateLog(`setCapabilityValueLog error ${capability} ${err.message}`);
        }
    }

    async addCapabilityLog(capability)
    {
        this.homey.app.updateLog(`addCapabilityLog ${capability}`);
        try
        {
            await this.addCapability(capability);
        }
        catch (err)
        {
            this.homey.app.updateLog(`addCapabilityLog error ${capability} ${err.message}`);
        }
    }

    async removeCapabilityLog(capability)
    {
        this.homey.app.updateLog(`removeCapabilityLog ${capability}`);
        try
        {
            await this.removeCapability(capability);
        }
        catch (err)
        {
            this.homey.app.updateLog(`removeCapabilityLog error ${capability} ${err.message}`);
        }
    }
}

module.exports = LinkTapDevice;
