import * as Yup from 'yup';
import { isBefore, startOfHour, parseISO, format, subHours } from 'date-fns';
import pt from 'date-fns/locale/pt';

// Importação de models
import Appointment from '../models/Appointment';
import User from '../models/User';
import File from '../models/File';

// Importação Schema
import Notification from '../schemas/Notification';

// Importação das Libs
import Queue from '../../lib/Queue';

// Importação dos Jobs
import CancellationJob from '../jobs/CancellationMail';

class AppointmentController {
  async index(req, res) {
    const { page = 1 } = req.query;

    const appointments = await Appointment.findAll({
      where: {
        user_id: req.userId,
        canceled_at: null,
      },
      attributes: ['id', 'date', 'past', 'cancelable'],
      order: ['date'],
      limit: 20,
      offset: (page - 1) * 20,
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['id', 'name'],
          include: [
            {
              model: File,
              as: 'avatar',
              attributes: ['id', 'path', 'url'],
            },
          ],
        },
      ],
    });

    return res.json(appointments);
  }

  async store(req, res) {
    const schema = Yup.object().shape({
      provider_id: Yup.number().required(),
      date: Yup.date().required(),
    });

    if (!schema.validate(req.body))
      return res.status(400).json({ error: 'Validation fails ' });

    const { provider_id, date } = req.body;

    if (provider_id === req.userId)
      return res
        .status(401)
        .json({ error: 'Number of provider can not be the same of user' });

    // Verifica se o provider_id é um provider
    const isProvider = await User.findOne({
      where: { id: provider_id, provider: true },
    });

    if (!isProvider)
      return res
        .status(401)
        .json({ error: 'You can only create appointment with providers' });

    // Verifica se o horario já passou
    const hourStart = startOfHour(parseISO(date));

    if (isBefore(hourStart, new Date()))
      return res.status(400).json({ error: 'Past date are not permitted ' });

    // Verifica se o horario já foi agendado
    const checkAvailability = await Appointment.findOne({
      where: {
        provider_id,
        canceled_at: null,
        date,
      },
    });

    if (checkAvailability)
      return res
        .status(400)
        .json({ error: 'Appointment date is not avaliable' });

    // Insere na tabela
    const appointment = await Appointment.create({
      user_id: req.userId,
      provider_id,
      date,
    });

    // Notifica prestador de serviço
    const user = await User.findByPk(req.userId);
    const formattedDate = format(
      hourStart,
      "'dia' dd 'de' MMMM', às' H:mm'h'",
      { locale: pt }
    );

    await Notification.create({
      content: `Novo agendamento de ${user.name} para ${formattedDate}`,
      user: provider_id,
    });

    return res.json(appointment);
  }

  async delete(req, res) {
    const appointment = await Appointment.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['name', 'email'],
        },
        {
          model: User,
          as: 'user',
          attributes: ['name'],
        },
      ],
    });

    if (appointment.user_id !== req.userId)
      return res.status(401).json({
        error: "You don'n have permission to cancel this appointment!",
      });

    const dateWithSub = subHours(appointment.date, 2);

    if (isBefore(dateWithSub, new Date()))
      return res.status(401).json({
        error: 'You can only cancel appointments with 2 hours in advance.',
      });

    appointment.canceled_at = new Date();

    await appointment.save();

    Queue.add(CancellationJob.key, {
      appointment,
    });

    return res.json(appointment);
  }
}

export default new AppointmentController();
