const express = require('express');
const path = require('path');
const { load, save } = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/habits', (req, res) => {
  const data = load();
  res.json({ habits: data.habits || [] });
});

app.post('/api/habits', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const data = load();
  const habit = {
    id: Date.now().toString(),
    name: name.trim(),
    streak: 0,
    lastChecked: null,
    history: []
  };
  data.habits = data.habits || [];
  data.habits.push(habit);
  save(data);
  res.status(201).json(habit);
});

app.post('/api/habits/:id/check', (req, res) => {
  const { id } = req.params;
  const data = load();
  const habit = (data.habits || []).find(h => h.id === id);
  if (!habit) {
    return res.status(404).json({ error: 'habit not found' });
  }
  const today = new Date().toISOString().split('T')[0];
  if (habit.lastChecked === today) {
    return res.status(400).json({ error: 'already checked today' });
  }
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  if (habit.lastChecked === yesterday) {
    habit.streak += 1;
  } else {
    habit.streak = 1;
  }
  habit.lastChecked = today;
  habit.history.push(today);
  save(data);
  res.json(habit);
});

app.delete('/api/habits/:id', (req, res) => {
  const { id } = req.params;
  const data = load();
  data.habits = (data.habits || []).filter(h => h.id !== id);
  save(data);
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('StreakBoard running on http://localhost:' + PORT);
});
