const http = require('http');
const https = require('https');
const fs = require('fs');
const Koa = require('koa');
const Router = require('koa-router');
const cors = require('koa2-cors');
const koaBody = require('koa-body');
const { Moon, JulianDay } = require("lunarphase-js");
const neatCsv = require('neat-csv');

const apikey = '86fecda88084dfdee3759ee92efb4d1b'

const totemsData = fs.readFileSync('./totems.csv', 'utf8')//тотемы
const worldCities = fs.readFileSync('./worldcities.csv', 'utf8')//города
const footbalEvents = JSON.parse(fs.readFileSync('./events-footbal.json'))//футбольные события с результатами
const currentPredictionsFile = JSON.parse(fs.readFileSync('./current-predictions.json'))//футбольные события с результатами
const footbalPredictions = JSON.parse(fs.readFileSync('./footbal-predictions.json'))//прошедшие предсказания на футбол
const nbaPredictions = JSON.parse(fs.readFileSync('./nba-predictions.json'))//прошедшие предсказания на баскет
const nhlPredictions = JSON.parse(fs.readFileSync('./nhl-predictions.json'))//прошедшие предсказания на хоккей
const comingEvents = JSON.parse(fs.readFileSync('./events-coming.json'))//события которые не произошли

async function getCity(searchCity) {
    const data = await parseCsv(worldCities)
    const [city] = data.filter(city => city.city.toLocaleLowerCase() === searchCity.toLocaleLowerCase())
    if(city) {
        return city
    }
    return null
}


async function parseCsv(data) {
    const totems = await neatCsv(data)
    return totems
}

function getTotems(response) {
    const totems = []
    response.forEach((totemObj, i) => {
        const [key] = Object.keys(totemObj)
        i === 0? totems.push(key, totemObj[key]) : totems.push(totemObj[key])
    })
    const result = totems.map((item, i) => {
        const [name, hash] = item.substring(0, item.length - 4).split("_")
        return {name, hash}
    })
    return result
}

function getPrediction(event, hash) {
    const {hour, minute, date, teamAway, teamHome} = event
    return hash.split('')[hour] + 
    hour +
    minute +
    hash.split('')[Math.floor(minute / 2)] + 
    teamHome[Math.floor(teamHome.length / 2)] +
    parseInt(teamHome[0].charCodeAt(0), 10) +
    parseInt(teamHome[teamHome.length - 1].charCodeAt(0), 10) +
    teamAway[Math.floor(teamAway.length / 2)] +
    parseInt(teamAway[0].charCodeAt(0), 10) +
    parseInt(teamAway[teamAway.length - 1].charCodeAt(0), 10) +
    parseInt(hash[hash.length - 1].charCodeAt(0), 10) +
    parseInt(hash[0].charCodeAt(0), 10) +
    teamHome.split('').reduce(reducer, 0) + 
    teamAway.split('').reduce(reducer, 0) +
    date.split('-').reduce(reducer, 0)
}

const reducer = (acc, el) => acc + parseInt(el.charCodeAt(0), 10)


function getMoonPhase(date) {
    const julian = JulianDay.fromDate(date);
    const phase = Moon.lunarPhase(date);
    const phaseEmoji = Moon.lunarPhaseEmoji(date);
    const age = Math.ceil(Moon.lunarAge(date));

    return {
        julian, 
        phase,
        phaseEmoji,
        age
    }
}

const app = new Koa();
app.use(cors());
app.use(koaBody({
    json: true
}));

const router = new Router();

function httpGet(lat, lng, params) {

    return new Promise(function(resolve, reject) {

    https.get(`https://api.openweathermap.org/data/2.5/onecall?lat=${lat}&lon=${lng}&exclude=current,minutely,hourly,alerts&units=metric&appid=${apikey}`, response => {
        let data = ''
        response.on('data', chunk => {
            data += chunk
        })
        response.on('end', () => {
            const weathers = JSON.parse(data).daily
            const [weatherCurrent] = weathers.filter(weather => {
                const [year, month, day] = params.date.split('-')
                return new Date(weather.dt * 1000).getDate() === parseInt(day, 10)
            })
            resolve(weatherCurrent)
            
        })
    })
    .on('error', error => {
        console.error(error)
    })
    .end()
    });
  
}

function getWeatherData(comingEvents) {
    return new Promise((resolve, reject) => {
        const result = comingEvents.map(async event => {
            const city = await getCity(event.city)
            const {lat, lng} = city
            const weather = await httpGet(lat, lng, event)
            return {...event, weather}
        })
        resolve(result)
    })
}

function createResultV2(events, totems) {
    const result = []
    events.forEach(async event => {
        const totemsPredictions = []
        totems.forEach(({name, hash}) => {
            const code = getPrediction(event, hash)
            const result = code.split('').reduce(reducer, 0) % 9
            if(result <= 3) {
                totemsPredictions.push({name, prediction: 'home'})
            } else if(result <= 6) {
                totemsPredictions.push({name, prediction: 'away'})
            } else {
                totemsPredictions.push({name, prediction: 'draw'})
            }
        })
        result.push({...event, totemsPredictions, moonPhase: getMoonPhase(new Date(event.date))})
    })
    return result
}

function calculateAccuracyTotems(events, totems) {
    const accuracyTotems = totems.map(totem => ({name: totem.name, count: 0, length: events.length}))
    if (events.length === 0) {
        return accuracyTotems.slice(0, 100)
    }
    
    events.forEach(({result, totemsPredictions}) => {
        totemsPredictions.forEach(totem => {
            if(totem.prediction === result) {
                accuracyTotems.find((accuracyTotem) => accuracyTotem.name === totem.name).count++
            }
        })
    })
    return accuracyTotems.sort((a,b) => {
        return b.count - a.count;
    }).slice(0, 100)
}

function checkPredictions(predictions, result) {
    if (predictions.length === 0) {
        return true
    }

    const predictionsFiltred = predictions.filter((prediction) => {
        if (prediction.type === result.type && 
        prediction.teamAway === 
        result.teamAway && 
        prediction.teamHome === result.teamHome && 
        prediction.date === result.date) {
            return prediction
        } 
    }) 

    if(predictionsFiltred.length === 0) {
        return false
    }
}

function writeResult(predictions, result, name) {
    if(!checkPredictions(predictions, result) ) {
        return
    }
    const predictionFiltred = currentPredictionsFile.filter(prediction => {
        if (prediction.type === result.type && 
            prediction.teamAway === 
            result.teamAway && 
            prediction.teamHome === result.teamHome && 
            prediction.date === result.date) {
                return prediction
        } 
    })

    if(predictionFiltred.length === 0) {
        return
    }
    predictionFiltred[0].result = result.result
    fs.writeFileSync(name, JSON.stringify(currentPredictions.push(predictionFiltred[0])));
}

function checkResults() {
    const comingEvents = JSON.parse(fs.readFileSync('./events-coming.json'))
    const results = comingEvents.filter(event => event.result)
    if (results.length === 0) {
        return
    }
    results.forEach(result => {
        if(result.type === 'Footbal') {
            writeResult(footbalPredictions, result, 'footbal-predictions.json')
        } else if (result.type === 'NBA') {
            writeResult(nbaPredictions, result, 'nba-predictions.json')
        } else {
            writeResult(nhlPredictions, result, 'nhl-predictions.json')
        }
    })
}


router.get('/api/coming-events', async (ctx, next) => {
    const data = await parseCsv(totemsData)
    const totems = getTotems(data)
    // const events = createResultV2(footbalEvents, totems)
    // fs.writeFileSync('footbal-predictions.json', JSON.stringify(events));
    checkResults()
    const footbalAccuracyTotems = calculateAccuracyTotems(footbalPredictions, totems)//точность предсказаний для футбола
    const nbaAccuracyTotems = calculateAccuracyTotems(nbaPredictions, totems)//точность предсказаний для nba
    const nhlAccuracyTotems = calculateAccuracyTotems(nhlPredictions, totems)//точность предсказаний для nhl
    const response = {
        currentPredictions: null, 
        footbalAccuracyTotems,
        nbaAccuracyTotems,
        nhlAccuracyTotems
    }
    if(currentPredictionsFile.length === 0) {
        const comingEventsWithWeather = await Promise.all(await getWeatherData(comingEvents))//погода на предстоящие матчи
        const currentPredictions = createResultV2(comingEventsWithWeather, totems)//текущие предсказания
        fs.writeFileSync('current-predictions.json', JSON.stringify(currentPredictions));
        response.currentPredictions =  JSON.parse(JSON.stringify(currentPredictions))
    } else  {
        response.currentPredictions =  JSON.parse(JSON.stringify(currentPredictionsFile))
    }

    ctx.response.body = JSON.stringify(response)
    return
});


router.post('/api/result-events', async (ctx, next) => {
    const data = await parseCsv(totemsData)
    const totems = getTotems(data)
    const {home,away,city,date,oldId,result, newId, type} = ctx.request.body

    const [editDate, time] = date.split('T')
    const [hour, minute] = time.split(':')
    const [oldPrediction] = currentPredictionsFile.filter(prediction => parseInt(prediction.id) === parseInt(oldId))

    const newComingEvents = comingEvents.filter(event => parseInt(event.id) !== parseInt(oldId) )
    const comingEvent = {
        teamHome: home,
        teamAway: away,
        date: editDate,
        hour: parseInt(hour),
        minute: parseInt(minute),
        type,
        city: city,
        result: false,
        id: newId
    }
    newComingEvents.push(comingEvent)
    const footbalAccuracyTotems = calculateAccuracyTotems(footbalPredictions, totems)
    const nbaAccuracyTotems = calculateAccuracyTotems(nbaPredictions, totems)
    const nhlAccuracyTotems = calculateAccuracyTotems(nhlPredictions, totems)
    const currentPredictions = currentPredictionsFile.filter(prediction => parseInt(prediction.id) !== parseInt(oldId))
    const comingEventsWithWeather = await Promise.all(await getWeatherData([comingEvent]))
    const [currentPrediction] = createResultV2(comingEventsWithWeather, totems)
    currentPredictions.push(currentPrediction)
    const response = {
        currentPredictions, 
        footbalAccuracyTotems,
        nbaAccuracyTotems,
        nhlAccuracyTotems
    }
    ctx.response.status = 200;
    ctx.response.body = JSON.stringify(response)

    fs.writeFileSync('events-coming.json', JSON.stringify(newComingEvents));
    fs.writeFileSync('current-predictions.json', JSON.stringify(currentPredictions));
    if (oldPrediction.type === "Footbal") {
        oldPrediction.result = result
        footbalPredictions.push(oldPrediction)
        fs.writeFileSync('footbal-predictions.json', JSON.stringify(footbalPredictions));
    } else if (oldPrediction.type === "NBA") {
        oldPrediction.result = result
        nbaPredictions.push(oldPrediction)
        fs.writeFileSync('nba-predictions.json', JSON.stringify(nbaPredictions));
    } else {
        oldPrediction.result = result
        nhlPredictions.push(oldPrediction)
        fs.writeFileSync('nhl-predictions.json', JSON.stringify(nhlPredictions));
    }
    return
});




app.use(router.routes())
app.use(router.allowedMethods());

const port = process.env.PORT || 7070;
const server = http.createServer(app.callback());
server.listen(port);

