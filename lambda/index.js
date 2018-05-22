// This file is dual-licensed under MPL 2.0 and MIT - you can use the source form
// provided under the terms of either of those licenses.

const AWS = require('aws-sdk');
const https = require('https');
const util = require('util');
const llamaConfig = require('./config.json');

AWS.config.region = llamaConfig.region || 'eu-west-1';

exports.handler = function(event, context) {
    console.log('Chaos Llama starting up');

    console.log('Configured region ' + AWS.config.region);

    if (llamaConfig.probability) {
        if (randomIntFromInterval(1,100) > llamaConfig.probability) {
            console.log('Probability says it is not chaos time');
            return context.done(null,null);
        }
    }

    let params = {};

    if(llamaConfig.stateFilter && llamaConfig.stateFilter.length > 0){
        params = {
            Filters: [
                {
                    Name: 'instance-state-name',
                    Values: llamaConfig.stateFilter
                },
            ]
        };
    }

    const ec2 = new AWS.EC2();

    ec2.describeInstances(params, function(err, data) {
        if (err) {
            return context.done(err, null);
        }

        if (!data || data.Reservations.length === 0) {
            console.log('No instances found, exiting.');
            return context.done(null, null);
        }

        let candidates = [];
        data.Reservations.forEach(function(res) {
            res.Instances.forEach(function(inst) {
                inst.Tags.forEach(function(tag) {
                    if (tag.Key === 'aws:autoscaling:groupName') {
                        // this instance is in an ASG
                        if (llamaConfig.enableForASGs) {
                            // this takes precedence - if defined we don't even look at disableForASGs
                            if (llamaConfig.enableForASGs.indexOf(tag.Value) !== -1) {
                                candidates.push(inst);
                            }
                        } else {
                            if (llamaConfig.disableForASGs) {
                                if (llamaConfig.disableForASGs.indexOf(tag.Value) === -1) {
                                    candidates.push(inst);
                                }
                            }
                        }
                    } else {
                        if (llamaConfig.enableForTags) {
                            llamaConfig.enableForTags.forEach(function(asgTags) {
                                if (asgTags.key === tag.Key && asgTags.value === tag.Value) {
                                    candidates.push(inst);
                                }
                            });
                        }
                    }
                });
            });
        });

        if(llamaConfig.verboselogging){
            console.log('candidates: %j', candidates);
        }else{
            console.log('candidates:');
            candidates.forEach(function(candidate){
                console.log(candidate.InstanceId);
            });
        }
        const numInstances = candidates.length;

        if (numInstances === 0) {
            console.log('No suitable instances found');
            return context.done(null);
        }

        const random = Math.floor(Math.random() * numInstances);
        const target = candidates[random];

        console.log('Going to terminate instance with id = %s', target.InstanceId);

        if (llamaConfig.slackWebhook) {
            llamaConfig.slackWebhook.forEach(function(slack) {
                if ( (slack.channel === null || typeof slack.channel === 'undefined') || (slack.webhookId === null || typeof slack.webhookId === 'undefined')) {
                    console.log('No channel or webhook specified. Slack message not sent.');
                    return context.done(null);
                }

                if (slack.username === null || typeof slack.username === 'undefined') {
                    slack.username = 'Chaos Lambda';
                }

                let name = 'Not Tagged';
                let asgName = 'undefined';

                target.Tags.forEach(function(tag){
                    if(tag.Key === 'Name'){
                        name = tag.Value;
                    }

                    if(tag.Key === 'aws:autoscaling:groupName'){
                        asgName = tag.Value;
                    }
                });

                // code taken from https://gist.github.com/stack72/ad97da2df376754e413a
                const slackMessage = [
                    "*Event*: CHAOS_TERMINATION - Terminate Instance",
                    "*Instance Name*: " + name,
                    "*Instance Id*: " + target.InstanceId + " (ASG *" + asgName + "*)",
                    "*Time*: " + getTimestamp(),
                ].join("\n");

                const postData = {
                    channel: slack.channel,
                    username: slack.username,
                    text: "*Chaos Lambda Termination Notification*",
                    attachments: [{text: slackMessage, mrkdwn_in: ["text"]}]
                };

                const options = {
                    method: 'POST',
                    hostname: 'hooks.slack.com',
                    port: 443,
                    path: '/services/' + slack.webhookId
                };

                const req = https.request(options, function (res) {
                    res.setEncoding('utf8');
                    if (res.statusCode !== "200") {
                        console.log('HTTP status code: %s', res.statusCode);
                        console.log('HTTP headers: %s', res.headers);
                    }
                    res.on('data', function (chunk) {
                        context.done(null);
                    });
                });

                req.on('error', function(e) {
                    context.fail(e);
                    console.log('request error: ' + e.message);
                });

                req.write(util.format("%j", postData));
                req.end();
            });
        }

        ec2.terminateInstances({InstanceIds:[target.InstanceId]}, function(err, data) {
            if (err) {
                return context.done(err, null);
            }

            console.log('Instance %s terminated', target.InstanceId);
            return context.done(null, data);
        });
    });
};

function randomIntFromInterval(min,max) {
    return Math.floor(Math.random()*(max-min+1)+min);
}

function getTimestamp() {
    const date = new Date();

    let hour = date.getHours();
    hour = (hour < 10 ? "0" : "") + hour;

    let min = date.getMinutes();
    min = (min < 10 ? "0" : "") + min;

    let sec = date.getSeconds();
    sec = (sec < 10 ? "0" : "") + sec;

    const year = date.getFullYear();

    let month = date.getMonth() + 1;
    month = (month < 10 ? "0" : "") + month;

    let day = date.getDate();
    day = (day < 10 ? "0" : "") + day;

    return year + "-" + month + "-" + day + " " + hour + ":" + min + ":" + sec + " UTC";
}