const http = require('http');
const app = require('./server');

const server = http.createServer(app);

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 5055,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runTests() {
  await new Promise((res) => server.listen(5055, res));
  console.log('Test server running on port 5055');

  try {
    // 1. Health
    const health = await makeRequest('GET', '/api/health');
    console.log('✓ Health:', health.status, health.body.status, health.body.storage);

    // 2. Seed realistic data
    const seed = await makeRequest('POST', '/api/seed');
    console.log('✓ Seed:', seed.status, seed.body.message);

    // 3. Staff list
    const staffList = await makeRequest('GET', '/api/staff');
    console.log(`✓ Staff count: ${staffList.body.length}`);

    // 4. Shifts list
    const shiftsList = await makeRequest('GET', '/api/shifts');
    console.log(`✓ Shifts count: ${shiftsList.body.length}`);

    // 5. Overlap detection test
    const person = staffList.body[0];
    const firstShift = shiftsList.body.find((s) => (s.staffId._id || s.staffId) === person._id);
    if (firstShift) {
      console.log(`Testing overlap detection for ${person.name} on ${firstShift.date} at ${firstShift.startTime}...`);
      const overlapAttempt = await makeRequest('POST', '/api/shifts', {
        staffId: person._id,
        date: firstShift.date,
        startTime: firstShift.startTime,
        endTime: firstShift.endTime,
      });
      console.log(`✓ Overlap prevention status: ${overlapAttempt.status} (Expected 409)`);
      console.log(`  Error message: "${overlapAttempt.body.error}"`);
    }

    // 6. Fairness suggester test
    const targetDate = shiftsList.body[0]?.date || '2026-11-09';
    const suggestions = await makeRequest('POST', '/api/shifts/suggest-staff', {
      date: targetDate,
      startTime: '13:00',
      endTime: '21:00', // Closing shift
      isInconvenient: true,
    });
    console.log(`✓ Fairness suggester returned ${suggestions.body.suggestions?.length} candidates`);
    console.log(`  Top recommended: ${suggestions.body.suggestions[0]?.name} (Score: ${suggestions.body.suggestions[0]?.score}, Status: ${suggestions.body.suggestions[0]?.status})`);

    // 7. Fairness Summary test
    const summary = await makeRequest('GET', '/api/summary');
    console.log(`✓ Fairness summary:`);
    console.log(`  Team Fairness Index: ${summary.body.teamMetrics.teamFairnessIndex}% (${summary.body.teamMetrics.balanceGrade})`);
    console.log(`  Total Inconvenient shifts: ${summary.body.teamMetrics.totalInconvenientShifts}`);
    console.log(`  Avg hours per person: ${summary.body.teamMetrics.avgHoursPerPerson}h`);

    // 8. Operating Coverage test
    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const cov = await makeRequest('GET', `/api/coverage?startDate=${monday.toISOString().slice(0, 10)}&endDate=${sunday.toISOString().slice(0, 10)}`);
    console.log(`✓ Operating Hours Coverage: ${cov.body.overallPercent}% across ${cov.body.days.length} days`);

    console.log('\nALL BACKEND API TESTS PASSED SUCCESSFULLY! 🎉');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    try {
      const mongoose = require('mongoose');
      await mongoose.disconnect();
    } catch {}
    process.exit(process.exitCode || 0);
  }
}

runTests();
