const fs = require('fs')
const config = require('../config.json')
const initAll = require('../rss/initializeall.js')
const storage = require('./storage.js')
const currentGuilds = storage.currentGuilds // Directory of guild profiles (Map)
const feedTracker = storage.feedTracker // Directory of all feeds, used to track between multiple feed schedules
const allScheduleWords = storage.allScheduleWords // Directory of all words defined across all schedules
const sqlCmds = require('../rss/sql/commands.js')
const sqlConnect = require('../rss/sql/connect.js')
const fileOps = require('./fileOps.js')
const checkGuild = require('./checkGuild.js')
const sendToDiscord = require('./sendToDiscord.js')
const process = require('child_process')
const configChecks = require('./configCheck.js')

module.exports = function(bot, callback) {
  try {
    var scheduleWordDir = {}
    const schedules = fs.readdirSync('./schedules') // Record all words in schedules for later use by FeedSchedules
    if (schedules.length === 1 && schedules[0] === 'exampleSchedule.json') console.log('No custom schedules detected.');
    for (var i in schedules) {
      if (schedules[i] !== 'exampleSchedule.json') {
        const schedule = JSON.parse(fs.readFileSync(`./schedules/${schedules[i]}`));
        if (!schedule.refreshTimeMinutes || typeof schedule.keywords !== 'object' || !schedule.keywords.length || schedule.keywords.length === 0) throw new Error(`Schedule named '${schedules[i]}' is improperly configured.`);

        const scheduleName = schedules[i].replace(/\.json/gi, '');

        scheduleWordDir[scheduleName] = [];
        const keywords = schedule.keywords;
        for (var x in keywords) {
          allScheduleWords.push(keywords[x]);
          scheduleWordDir[scheduleName].push(keywords[x]);
        }
      }
    }
  }
  catch(e) {
    console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}INIT Info: No schedules found due to no schedules folder.`)
  }


  const guildList = []
  const modSourceList = new Map()
  const sourceList = new Map()
  const regBatchList = []
  const modBatchList = []
  const batchSize = (config.advanced && config.advanced.batchSize) ? config.advanced.batchSize : 400
  let skippedFeeds = 0
  let initializedFeeds = 0
  let con

  function genBatchLists() {
    let batch = new Map()

    sourceList.forEach(function(rssList, link) { // rssList per link
      if (batch.size >= batchSize) {
        regBatchList.push(batch);
        batch = new Map();
      }
      batch.set(link, rssList)
    })

    if (batch.size > 0) regBatchList.push(batch);

    batch = new Map()

    modSourceList.forEach(function(source, link) { // One RSS source per link instead of an rssList
      if (batch.size >= batchSize) {
        modBatchList.push(batch);
        batch = new Map();
      }
      batch.set(link, source)
    })

    if (batch.size > 0) modBatchList.push(batch);

  }

  function addToSourceLists(rssList, guildId) { // rssList is an object per guildRss
    for (var rssName in rssList) {

      if (configChecks.checkExists(rssName, rssList[rssName], true, true) && configChecks.validChannel(bot, guildId, rssList[rssName])) {

        checkGuild.roles(bot, guildId, rssName); // Check for any role name changes

        if (rssList[rssName].advanced && rssList[rssName].advanced.size() > 0) { // Special source list for feeds with unique settings defined, each linkList only has 1 item
          let linkList = {};
          linkList[rssName] = rssList[rssName];
          modSourceList.set(rssList[rssName].link, linkList);
        }
        else if (sourceList.has(rssList[rssName].link)) { // Regular source lists, optimized for faster operation by aggregating feeds of same links
          let linkList = sourceList.get(rssList[rssName].link);
          linkList[rssName] = rssList[rssName];
        }
        else {
          let linkList = {};
          linkList[rssName] = rssList[rssName];
          sourceList.set(rssList[rssName].link, linkList);
        }

        // Assign feeds to specific schedules in feedTracker for use by feedSchedules
        if (scheduleWordDir && scheduleWordDir.size() > 0) {
          for (var scheduleName in scheduleWordDir) {
            let wordList = scheduleWordDir[scheduleName];
            for (var i in wordList) {
              if (rssList[rssName].link.includes(wordList[i]) && !feedTracker[rssName]) {
                console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}INIT: Assigning feed ${rssName} to ${scheduleName}`)
                feedTracker[rssName] = scheduleName; // Assign a schedule to a feed if it doesn't already exist in the feedTracker to another schedule
              }
            }
          }
          if (!feedTracker[rssName]) feedTracker[rssName] = 'default'; // Assign to default schedule if it wasn't assigned to a custom schedule
        }
      }

    }
  }

  function addGuildRss(guildFile) {
    const guildId = guildFile.replace(/.json/g, '') // Remove .json file ending since only the ID is needed
    if (!bot.guilds.get(guildId)) { // Check if it is a valid guild in bot's guild collection
       if (guildFile === 'master.json' || guildFile === 'guild_id_here.json' || guildFile === 'backup') return;
       if (bot.shard) return bot.shard.send({type: 'missingGuild', content: guildId});
       else return console.log(`RSS Guild Profile: ${guildFile} was not found in bot's guild list. Skipping.`);
     }

    try {
      const guildRss = JSON.parse(fs.readFileSync(`./sources/${guildFile}`))
      const rssList = guildRss.sources
      if (fileOps.isEmptySources(guildRss)) return; // Skip when empty source object

      if (!currentGuilds.has(guildId) || JSON.stringify(currentGuilds.get(guildId)) !== JSON.stringify(guildRss)) {
        currentGuilds.set(guildId, guildRss);
        checkGuild.names(bot, guildId);
      }
      addToSourceLists(rssList, guildId)
    }
    catch(err) {return fileOps.checkBackup(err, guildId)}
  }

  fs.readdir('./sources', function(err, files) {
    if (err) throw err;
    files.forEach(addGuildRss)
    if (sourceList.size + modSourceList.size === 0) {
      console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}RSS Info: There are no active feeds to initialize.`);
      if (bot.shard) bot.shard.send({type: 'initComplete'})
      return callback();
    }
    return connect();
  })

  function connect() {
    console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}RSS Info: Starting initialization cycle.`)
    genBatchLists()

    switch(config.advanced.processorMethod) {
      case 'single':
        con = sqlConnect(function(err) {
          if (err) throw new Error(`Could not connect to SQL database for initialization. (${err})`)
          getBatch(0, regBatchList, 'regular')
        })
        break;
      case 'isolated':
        getBatchIsolated(0, regBatchList, 'regular');
        break;
      case 'parallel':
        getBatchParallel();
    }
  }

  function getBatch(batchNumber, batchList, type) {
    if (batchList.length === 0) return getBatch(0, modBatchList, 'modded');
    let currentBatch = batchList[batchNumber]
    let completedLinks = 0

    currentBatch.forEach(function(rssList, link) { // rssList is an rssList of a specific link
      var uniqueSettings = undefined
      for (var mod_rssName in rssList) {
        if (rssList[mod_rssName].advanced && rssList[mod_rssName].advanced.size() > 0) {
          uniqueSettings = rssList[mod_rssName].advanced
        }
      }

      initAll(con, link, rssList, uniqueSettings, function(completedLink, article) {
        if (article) sendToDiscord(bot, article, function(err) { // This can result in great spam once the loads up after a period of downtime
          if (err) console.log(err);
        });
        if (!completedLink) return;

        completedLinks++
        console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}Batch ${batchNumber + 1} (${type}) Progress: ${completedLinks}/${currentBatch.size}`)
        if (completedLinks === currentBatch.size) {
          if (batchNumber !== batchList.length - 1) setTimeout(getBatch, 200, batchNumber + 1, batchList, type);
          else if (type === 'regular' && modBatchList.length > 0) setTimeout(getBatch, 200, 0, modBatchList, 'modded');
          else return endCon();
        }

      })
    })
  }

  function getBatchIsolated(batchNumber, batchList, type) {
    if (batchList.length === 0) return getBatchIsolated(0, modBatchList, 'modded');
    let completedLinks = 0
    let currentBatch = batchList[batchNumber]

    const processor = process.fork('./rss/initializeallProcessor.js')

    currentBatch.forEach(function(rssList, link) {
      var uniqueSettings = undefined
      for (var mod_rssName in rssList) {
        if (rssList[mod_rssName].advanced && rssList[mod_rssName].advanced.size() > 0) {
          uniqueSettings = rssList[mod_rssName].advanced;
        }
      }
      processor.send({link: link, rssList: rssList, uniqueSettings: uniqueSettings})
    })

    processor.on('message', function(m) {
      if (m.type === 'kill') {
        if (bot.shard) bot.shard.broadcastEval('process.exit()');
        throw m.contents; // Full error is printed from the processor
      }
      if (m === 'linkComplete') {
        completedLinks++;
        console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}Batch ${batchNumber + 1} (${type}) Progress: ${completedLinks}/${currentBatch.size}`)

        if (completedLinks === currentBatch.size) {
          if (batchNumber !== batchList.length - 1) setTimeout(getBatchIsolated, 200, batchNumber + 1, batchList, type);
          else if (type === 'regular' && modBatchList.length > 0) setTimeout(getBatchIsolated, 200, 0, modBatchList, 'modded');
          else finishCycle();
          processor.kill();
        }
      }
      else sendToDiscord(bot, m.article, function(err) { // This can result in great spam once the loads up after a period of downtime
        if (err) console.log(err);
      });
    })
  }

  function getBatchParallel() {
    let totalBatchLengths = regBatchList.length + modBatchList.length
    let totalLinks = 0
    for (var x in regBatchList) {
      totalLinks += regBatchList[x].size;
    }
    for (var y in modBatchList) {
      totalLinks += modBatchList[y].size;
    }
    let completedBatches = 0
    let totalCompletedLinks = 0

    function deployProcessors(batchList, index) {
      let completedLinks = 0

      const processor = process.fork('./rss/initializeallProcessor.js')
      let currentBatch = batchList[index];

      processor.on('message', function(m) {
        if (m.type === 'kill') {
          if (bot.shard) bot.shard.broadcastEval('process.exit()');
          throw m.contents; // Full error is printed from the processor
        }
        if (m === 'linkComplete') {
          completedLinks++;
          totalCompletedLinks++;
          console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}Parallel Progress: ${totalCompletedLinks}/${totalLinks}`)
          if (completedLinks === currentBatch.size) {
            completedBatches++;
            processor.kill();
            if (completedBatches === totalBatchLengths) finishCycle();
          }
        }
        else sendToDiscord(bot, m.article, function(err) { // This can result in great spam once the loads up after a period of downtime
          if (err) console.log(err);
        });
      })

      currentBatch.forEach(function(rssList, link) {
        var uniqueSettings = undefined
        for (var mod_rssName in rssList) {
          if (rssList[mod_rssName].advanced && rssList[mod_rssName].advanced.size() > 0) {
            uniqueSettings = rssList[mod_rssName].advanced;
          }
        }
        processor.send({link: link, rssList: rssList, uniqueSettings: uniqueSettings})
      })
    }

    for (var i in regBatchList) {deployProcessors(regBatchList, i)}
    for (var y in modBatchList) {deployProcessors(modBatchList, y)}
  }

  function endCon() {
    sqlCmds.end(con, function(err) {
      finishCycle()
    })
  }

  function finishCycle() {
    console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ': ''}INIT Info: Finished initialization cycle.`)
    if (bot.shard) bot.shard.send({type: 'initComplete'})
    callback()
  }

}
