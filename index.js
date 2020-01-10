require('dotenv').config();
const Axios = require('axios');
const qs = require('querystring');

const DEBUG_MODE = process.env.CPN_DEBUG_MODE || true;

const slackHookUrl = process.env.CPN_SLACK_HOOK_URL;
const slackUserIdsString = process.env.CPN_SLACK_USER_IDS || 'farzaddaei:WCMTDDDRV';

const chargePointBaseUrl = process.env.CPN_CP_BASE_URL || 'https://na.chargepoint.com';
const chargePointUsername = process.env.CPN_CP_USERNAME;
const chargePointPassword = process.env.CPN_CP_PASSWORD;
const chargePointDeviceId = process.env.CPN_CP_DEVICE_ID || '93737';

const pollingDelay = process.env.CPN_POLLING_DELAY || 60 * 1000;
const authDelay = process.env.CPN_AUTH_DELAY || 30 * 60 * 1000;
const exitWarningOffset = process.env.CPN_WARNING_OFFSET || 5 * 60;
const workingStarTime = process.env.CPN_WORKING_START_TIME || 8;
const workingStopTime = process.env.CPN_WORKING_STOP_TIME || 18;

const sundayDayOfWeek = 1;
const saturdayDayOfWeek = 6;
const weekendSleepTime = 6 * 60 * 60 * 1000;
const afterHoursSleepTime = 60 * 60 * 1000;

let chargePointToken;
let lastAuth;
const slackUserIds = {};
const chargingUsers = {1: null, 2: null};
const onHoldUsers = {1: null, 2: null};

/**
 * Generates a new auth/session token to use with ChargePoint API
 * @param username The user's username
 * @param password The user's password
 * @returns string Session Token
 */
const generateChargePointToken = async (username, password) => {
    const response = await Axios
        .post(`${chargePointBaseUrl}/users/validate`, qs.stringify({
            user_name: username,
            user_password: password,
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

    const data = response.data;

    return data.sessionStorage.ci_ui_session;
};

/**
 * Retrieves all the information about the wait-list for a station
 * @param deviceId The station/device ID to query
 * @param token The session token used to authenticate the user
 * @returns object The station queue details
 */
const getChargePointStationQueueDetail = async (deviceId, token) => {
    const response = await Axios
        .post(`${chargePointBaseUrl}/community/getStationQueueDetail`, qs.stringify({
            deviceId,
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'cookie': `ci_ui_session=${token};`
            }
        });

    const data = response.data.response.message;

    return {
        maxChargingTime: parseInt(data.maxChargingTime),
        currTime: parseInt(data.currTime),
        chargingUsers: data.chargingUsers.map(user => ({
            id: user.subscriberId,
            name: user.subscriberEvatarName,
            status: user.subscriberQueueState,
            startTime: parseInt(user.pluginEpochTime) / 1000,
            outlet: user.outletNumber,
            exitNotified: false
        })).filter(user => user.id !== undefined),
        onHoldUsers: data.onHoldUsers.map(user => ({
            id: user.subscriberId,
            name: user.subscriberEvatarName,
            status: user.portQueueSubState,
            outlet: user.outletNumber,
            waitingNotified: false
        }))
    }
};

/**
 * Send a message through Slack's Incoming Webhook API
 * @param text The content of the message
 */
const sendSlackMessage = (text) => {
    if (DEBUG_MODE) {
        console.log(text);
        return;
    }

    Axios
        .post(slackHookUrl, { text })
        .catch((error) => {
            console.log(error);
        });
};

/**
 * The main polling function
 */
const pollChargePoint = async (firstRun) => {
    // Hacky/Lazy implementation for start/stop time
    const dateNow = new Date();
    if (dateNow.getDay() === sundayDayOfWeek || dateNow.getDay() === saturdayDayOfWeek) {
        setTimeout(pollChargePoint, weekendSleepTime);
        return;
    } else if (dateNow.getHours() < workingStarTime || dateNow.getHours() > workingStopTime) {
        setTimeout(pollChargePoint, afterHoursSleepTime);
        return;
    }

    // (Re)Authenticate with ChargePoint
    if (!chargePointToken || new Date(lastAuth.getTime() + authDelay) <= new Date()) {
        chargePointToken = await generateChargePointToken(chargePointUsername, chargePointPassword);
        lastAuth = new Date();
    }

    // Retrieve ChargePoint station data
    const stationQueueDetail = await getChargePointStationQueueDetail(chargePointDeviceId, chargePointToken);
    const maxChargingTime = stationQueueDetail.maxChargingTime;
    const currTime = stationQueueDetail.currTime;

    // Process the currently charging users
    stationQueueDetail.chargingUsers.forEach(user => {
        const outlet = user.outlet;

        // Update the current user charging
        if (!chargingUsers[outlet] || chargingUsers[outlet].id !== user.id) {
            chargingUsers[outlet] = user;

            // Notify user started charge session and end time
            if (!firstRun) {
                const endTime = new Date((chargingUsers[outlet].startTime + maxChargingTime) * 1000);

                sendSlackMessage(`${chargingUsers[outlet].name} has started charging. Their session will end at ${endTime.toLocaleTimeString('en-US',
                    {
                        hour: '2-digit',
                        minute: '2-digit'
                    })}.`);
            }
        }

        // Notify 5 minutes of charging left
        if (chargingUsers[outlet].status === 'CHARGING' &&
            slackUserIds[chargingUsers[outlet].name] !== undefined &&
            chargingUsers[outlet].startTime + maxChargingTime <= currTime + exitWarningOffset &&
            !chargingUsers[outlet].exitNotified) {
            sendSlackMessage(`<@${slackUserIds[chargingUsers[outlet].name]}> - Your time is almost up.`);
            chargingUsers[outlet].exitNotified = true;
        }
    });

    // Process the on hold users
    stationQueueDetail.onHoldUsers.forEach(user => {
        const outlet = user.outlet;

        // Update a new user on hold
        if (!onHoldUsers[outlet] || onHoldUsers[outlet].id !== user.id) {
            onHoldUsers[outlet] = user;
        }

        // Notify waiting on user to accept
        if (onHoldUsers[outlet].status === 'ACCEPT_PENDING' &&
            slackUserIds[onHoldUsers[outlet].name] !== undefined &&
            !onHoldUsers[outlet].waitingNotified) {
            sendSlackMessage(`<@${slackUserIds[onHoldUsers[outlet].name]}> -- It's your turn.`);
            onHoldUsers[outlet].waitingNotified = true;
        }
    });

    // Schedule the next poll
    setTimeout(pollChargePoint, pollingDelay);
};

// Parse the slack user ids
try {
    slackUserIdsString.split(';').forEach(user => {
        const userParts = user.split(':');
        if (userParts.length < 2) return;

        slackUserIds[userParts[0]] = userParts[1];
    });
} catch (error) {
    console.log(`Unable to parse user ids: ${error}`);
}

// Start polling
pollChargePoint(true)
    .then(() => {
        console.log('Polling started...')
    })
    .catch(error => {
        console.log(`Something went wrong... ${error}`);
    });

